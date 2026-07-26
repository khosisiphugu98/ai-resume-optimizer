/**
 * Matching an answer onto the options a form actually offers.
 *
 * Every collector reports select/radio/combobox choices as literal label text,
 * and until now each caller compared its value to those labels with exact,
 * case-insensitive equality. That fails on the ordinary case where the answer is
 * true but worded differently: the profile says a notice period of "30 days",
 * the dropdown offers "1 month"; the profile says 3 years of SQL, the dropdown
 * offers "3-5 years". The field then parks or throws at fill time.
 *
 * The rules below are ranked, and each one is meant to preserve the truth of the
 * answer rather than merely find a close string:
 *
 *   exact       identical text
 *   normalized  same text ignoring case, punctuation and spacing
 *   tokens      same words in a different order/with filler words
 *   boolean     the answer's yes/no polarity, when exactly one option carries it
 *   duration    the same length of time, in different units
 *   range       the answer's number falls inside the option's range
 *   contains    the answer is a phrase inside exactly one option
 *
 * The first four are `safe`: they restate the answer, so the fill layer may use
 * them without anyone reviewing the result. The last three interpret it, so they
 * are gated behind `semantic: true` and callers mark what they produce as
 * `probable` — `duration-ceiling` and `contains` in particular are a judgement
 * call, and the whole point of the review queue is that a judgement call gets
 * seen before it is submitted.
 */

const SAFE_RULES = new Set(['exact', 'normalized', 'tokens', 'boolean']);

/** Lowercase, strip punctuation, keep the characters ranges are written with. */
const norm = s => String(s ?? '')
  .toLowerCase()
  .replace(/[’´`]/g, "'")
  .replace(/[^a-z0-9+<>=.'\- ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Words that carry no meaning in an option label. Deliberately short: dropping a
// word that distinguishes two options would match the wrong one.
const FILLER = new Set(['a', 'an', 'the', 'of', 'my', 'your', 'i', 'is', 'are', 'am', 'do', 'does', 'to', 'in', 'at', 'for', 'please', 'select', 'option', 'approximately', 'approx', 'about', 'around']);

const tokens = s => norm(s).split(/[^a-z0-9+<>=.]+/).filter(w => w && !FILLER.has(w));

const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const DAYS_PER = { day: 1, week: 7, month: 30, year: 365 };

const numberish = w => (w in WORD_NUMBERS ? WORD_NUMBERS[w] : (/^\d+(\.\d+)?$/.test(w) ? Number(w) : null));

// Words that may sit around a duration without turning it into prose:
// "2 weeks notice", "60 days or less", "available in 1 month".
const DURATION_FRAME = new Set(['notice', 'period', 'or', 'more', 'less', 'plus', 'and', 'above', 'below', 'longer', 'sooner', 'minimum', 'maximum', 'min', 'max', 'least', 'most', 'than', 'up', 'within', 'after', 'from', 'now', 'available', 'availability', 'start', 'calendar', 'working', 'business', 'notice-period']);

/**
 * A length of time in days, as a closed interval. "2 weeks" is [14,14],
 * "1-2 months" is [30,60], "immediately" is [0,0]. Null when the text is not a
 * duration at all.
 *
 * `bare` says whether the text is a duration or merely contains one. "3 months"
 * is bare; "I spent 3 months there" is not, and a match built on it is an
 * interpretation of a sentence rather than a reading of a label.
 */
function toDays(text) {
  const t = norm(text);
  if (!t) return null;

  // What is left once the duration expression is removed. All frame words means
  // the text was a duration; anything else means it was a sentence containing one.
  const bareness = matched => tokens(t.replace(matched, ' ')).every(w => DURATION_FRAME.has(w));

  const immediate = t.match(/\b(immediately|immediate|asap|as soon as possible|right away|straight away|no notice period|no notice|none)\b/);
  if (immediate) return { lo: 0, hi: 0, bare: bareness(immediate[0]) };
  if (t === 'now') return { lo: 0, hi: 0, bare: true };

  const num = '(\\d+(?:\\.\\d+)?|' + Object.keys(WORD_NUMBERS).join('|') + '|a|an)';
  const unit = '(day|week|month|year)s?';

  // "1-2 months", "1 to 2 months", "2 weeks - 1 month"
  const span = t.match(new RegExp(`${num}\\s*(?:${unit})?\\s*(?:-|–|to|until)\\s*${num}\\s*${unit}`));
  if (span) {
    const [, aRaw, aUnit, bRaw, bUnit] = span;
    const a = aRaw === 'a' || aRaw === 'an' ? 1 : numberish(aRaw);
    const b = bRaw === 'a' || bRaw === 'an' ? 1 : numberish(bRaw);
    if (a != null && b != null) {
      const lo = a * DAYS_PER[aUnit || bUnit];
      const hi = b * DAYS_PER[bUnit];
      if (lo <= hi) return { lo, hi, bare: bareness(span[0]) };
    }
  }

  const one = t.match(new RegExp(`${num}\\s*${unit}`));
  if (one) {
    const n = one[1] === 'a' || one[1] === 'an' ? 1 : numberish(one[1]);
    if (n != null) {
      const days = n * DAYS_PER[one[2]];
      const bare = bareness(one[0]);
      // "3 months or more" is open-ended; treat the stated figure as the floor.
      if (/\b(or more|\+|plus|and above|or longer)\b/.test(t)) return { lo: days, hi: Infinity, bare };
      return { lo: days, hi: days, bare };
    }
  }
  return null;
}

/**
 * The numeric interval an option describes: "3-5" → [3,5], "5+" → [5,∞),
 * "more than 5" → (5,∞), "less than 1" → [0,1), "none" → [0,0].
 * Null when the option carries no number.
 */
function toRange(text) {
  const t = norm(text);
  if (!t) return null;
  if (/^(none|no experience|no|not applicable|n\/a|na)$/.test(t)) return { lo: 0, hi: 0, loOpen: false, hiOpen: false };

  const nums = t.split(/[^a-z0-9.]+/).map(numberish).filter(n => n != null);
  if (!nums.length) return null;

  const span = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
  if (span) {
    const lo = Number(span[1]), hi = Number(span[2]);
    if (lo <= hi) return { lo, hi, loOpen: false, hiOpen: false };
  }

  const n = nums[0];
  if (/\+|\bor more\b|\bor above\b|\band above\b|\bplus\b/.test(t)) return { lo: n, hi: Infinity, loOpen: false, hiOpen: false };
  if (/\b(more than|over|greater than|above)\b|>/.test(t)) return { lo: n, hi: Infinity, loOpen: !/>=/.test(t), hiOpen: false };
  if (/\b(at least|minimum|min)\b/.test(t)) return { lo: n, hi: Infinity, loOpen: false, hiOpen: false };
  if (/\b(less than|fewer than|under|below)\b|</.test(t)) return { lo: 0, hi: n, loOpen: false, hiOpen: !/<=/.test(t) };
  if (/\b(up to|at most|maximum|max|or less|or fewer)\b/.test(t)) return { lo: 0, hi: n, loOpen: false, hiOpen: false };
  return { lo: n, hi: n, loOpen: false, hiOpen: false };
}

const inRange = (n, r) =>
  (r.loOpen ? n > r.lo : n >= r.lo) && (r.hiOpen ? n < r.hi : n <= r.hi);

const width = r => (r.hi === Infinity ? Infinity : r.hi - r.lo);

/** 'yes', 'no', or null. Polarity only — never a guess at what the option means. */
function polarity(text) {
  const t = norm(text);
  if (!t) return null;
  if (/^(not applicable|n\/a|na|none|prefer not|decline|do not wish|choose not)/.test(t)) return null;
  if (/^(yes|y|true|correct|agreed?|accept|confirmed?)\b/.test(t)) return 'yes';
  if (/^i (am|do|have|will|can|would|hold)\b/.test(t) && !/\bnot\b|n't/.test(t)) return 'yes';
  if (/^(no|n|false|incorrect|disagree)\b/.test(t)) return 'no';
  if (/^i (am|do|have|will|can|would|hold)\s+(not|n't)\b/.test(t) || /^i (don't|doesn't|can't|won't|haven't|am not)\b/.test(t)) return 'no';
  return null;
}

/** The one index where `pred` holds, or -1 if it holds nowhere or more than once. */
function onlyIndex(list, pred) {
  let found = -1;
  for (let i = 0; i < list.length; i++) {
    if (!pred(list[i], i)) continue;
    if (found !== -1) return -1;
    found = i;
  }
  return found;
}

/**
 * Match `value` onto `options`.
 *
 * @param {string} value      the answer as resolved
 * @param {string[]} options  the labels the form offers, in DOM order
 * @param {object} [opts]
 * @param {boolean} [opts.semantic=false]  allow the interpreting rules
 * @returns {{option: string, index: number, rule: string, confident: boolean}|null}
 */
export function matchOption(value, options, { semantic = false } = {}) {
  const list = Array.isArray(options) ? options.filter(o => o != null).map(String) : [];
  if (!list.length || value == null || value === '') return null;

  const hit = (index, rule, confident = true) =>
    (index === -1 ? null : { option: list[index], index, rule, confident });

  const v = String(value);

  const exact = list.indexOf(v);
  if (exact !== -1) return hit(exact, 'exact');

  const nv = norm(v);
  const normalized = list.findIndex(o => norm(o) === nv);
  if (normalized !== -1) return hit(normalized, 'normalized');

  const tv = tokens(v);
  if (tv.length) {
    const key = [...tv].sort().join(' ');
    const byTokens = onlyIndex(list, o => {
      const to = tokens(o);
      return to.length === tv.length && [...to].sort().join(' ') === key;
    });
    if (byTokens !== -1) return hit(byTokens, 'tokens');
  }

  const pv = polarity(v);
  if (pv) {
    const byPolarity = onlyIndex(list, o => polarity(o) === pv);
    if (byPolarity !== -1) return hit(byPolarity, 'boolean');
  }

  if (!semantic) return null;

  // Same length of time, said differently. Both sides must parse as a duration,
  // or "30 days" would happily match a salary band containing the number 30.
  const vd = toDays(v);
  if (vd) {
    const parsed = list.map(toDays);
    if (parsed.some(Boolean)) {
      // A sentence that merely contains a duration ("I have three years") is read,
      // but never confidently — the reading is of prose, not of a stated length.
      const overlaps = onlyIndex(parsed, r => r && r.lo <= vd.hi && vd.lo <= r.hi);
      if (overlaps !== -1) return hit(overlaps, 'duration', vd.bare);

      // Nothing on offer covers the answer. Round up, never down: an option
      // sooner than the true notice period would promise a date that cannot be
      // met. Flagged as unconfident so review sees the substitution.
      let ceiling = -1;
      for (let i = 0; i < parsed.length; i++) {
        if (!parsed[i] || parsed[i].lo < vd.hi) continue;
        if (ceiling === -1 || parsed[i].lo < parsed[ceiling].lo) ceiling = i;
      }
      if (ceiling !== -1) return hit(ceiling, 'duration-ceiling', false);
      return null;
    }
  }

  // A bare number against banded options: "3" onto "3-5 years". Requires the
  // value to be only a number (plus an optional unit), so prose never lands here.
  const bare = nv.match(/^(\d+(?:\.\d+)?)\s*(?:\+|years?|yrs?|months?|days?)?$/);
  if (bare) {
    const n = Number(bare[1]);
    const ranges = list.map(toRange);
    const matches = [];
    for (let i = 0; i < ranges.length; i++) if (ranges[i] && inRange(n, ranges[i])) matches.push(i);
    if (matches.length) {
      // Bands can overlap at their edges ("1-3" and "3-5" both hold 3). The
      // tighter band is the more specific true statement.
      const best = matches.reduce((a, b) => (width(ranges[b]) < width(ranges[a]) ? b : a));
      return hit(best, 'range');
    }
  }

  // Last resort: the answer is a phrase inside exactly one option, or exactly one
  // option is a phrase inside the answer. Uniqueness is what makes it safe enough
  // to offer at all, and it is never confident.
  if (nv.length >= 3) {
    const phrase = new RegExp(`(^|\\W)${nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`);
    const inside = onlyIndex(list, o => phrase.test(norm(o)));
    if (inside !== -1) return hit(inside, 'contains', false);

    const wraps = onlyIndex(list, o => {
      const no = norm(o);
      return no.length >= 3 && new RegExp(`(^|\\W)${no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(nv);
    });
    if (wraps !== -1) return hit(wraps, 'contains', false);
  }

  return null;
}

/** True when a rule restates the answer rather than interpreting it. */
export const isSafeRule = rule => SAFE_RULES.has(rule);

/**
 * Index of the option to fill, for the fill layer. Safe rules only — by the time
 * a value reaches a control it has already been resolved against the options, so
 * anything looser here would be reinterpreting an answer nobody would see again.
 */
export const matchOptionIndex = (value, options) => {
  const m = matchOption(value, options);
  return m ? m.index : -1;
};
