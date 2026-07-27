import { skillYears, authorisationFor } from '../profile.js';

const ok = (value, extra = null) => ({ value, source: 'profile', ...extra });
const park = reason => ({ park: reason });

/**
 * Phrases that qualify "experience" rather than naming something to have it in.
 * A match here means the question was about overall experience all along.
 */
const GENERIC_EXPERIENCE_QUALIFIERS =
  /^(relevant|full[- ]?time|part[- ]?time|paid|unpaid|professional|work|working|industry|corporate|commercial|overall|general|total|post[- ]?graduate|related|similar|this (field|area|role|industry)|the (field|industry|role))(\s+(relevant|full[- ]?time|part[- ]?time|paid|professional|work|working|industry|related|similar))*$/i;

/** A control offering exactly the two answers to a closed question. */
const isYesNo = opts =>
  Array.isArray(opts) && opts.length === 2 &&
  opts.some(o => /^\s*yes\b/i.test(String(o))) && opts.some(o => /^\s*no\b/i.test(String(o)));

/**
 * The threshold a "do you have N years" question is testing, or null.
 *
 * A range takes its LOWER bound: "4-5 years" is satisfied by four, so four is what
 * has to be met.
 */
export function requiredYearsIn(question) {
  const m = normalisePunctuation(question).match(/(\d+)\s*(?:\+|-|to)?\s*\d*\s*\+?\s*years?/i);
  return m ? Number(m[1]) : null;
}

/**
 * Whether the candidate meets a years threshold — true, false, or null when the
 * profile cannot settle it and the question must park.
 *
 * The total-years figure is only used for questions that ask about experience in
 * general. When a specific technology is named and the profile does not confirm
 * it, the answer is a plain no: substituting the overall total there would let
 * three years of marketing analytics answer "do you have 5 years of Kubernetes".
 */
export function meetsYearsThreshold(profile, question) {
  const need = requiredYearsIn(question);
  if (need == null) return null;

  const skill = extractSkill(question);
  if (skill) {
    const { value } = skillYears(profile, skill);
    return typeof value === 'number' ? value >= need : false;
  }

  const total = profile.current?.confirmed ? profile.current.totalYearsExperience : null;
  return typeof total === 'number' ? total >= need : null;
}

/** "South Africa (+27)" — the shape of a country-code option. */
const isDiallingCode = opt => /\(\+\d{1,4}\)|^\+\d{1,4}$/.test(String(opt));
const isEmailLike = opt => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(opt).trim());

/**
 * Tier 1 of the resolution ladder — deterministic profile lookups. Anything
 * matched here never reaches a model.
 *
 * Order matters: the years-of-experience matcher must come before generic
 * numeric matchers, and EEO before anything that mentions "identify".
 */
export const MATCHERS = [
  // ---- Identity -----------------------------------------------------------
  { name: 'firstName', test: /^(first|given)\s*name$|^forename/, resolve: p => ok(p.identity.firstName) },
  { name: 'lastName',  test: /^(last|family|sur)\s*name$|^surname/, resolve: p => ok(p.identity.lastName) },
  { name: 'fullName',  test: /^(full|legal)?\s*name$|your name/, resolve: p => ok(`${p.identity.firstName} ${p.identity.lastName}`) },
  // An email control that offers a fixed list is not asking which address to type,
  // it is asking which of these addresses is yours — LinkedIn only offers the ones
  // verified on the account. The profile address is frequently not among them, and
  // string equality against the list can only fail. Match on the mailbox instead,
  // and otherwise prefer a real address over an Apple private-relay alias.
  {
    name: 'email',
    test: /e[- ]?mail/,
    resolve: (p, ctx) => {
      const mine = p.identity.email;
      const opts = ctx.options || [];
      if (!opts.length || !opts.every(isEmailLike)) return ok(mine);

      const local = String(mine).split('@')[0].toLowerCase();
      const sameMailbox = opts.find(o => String(o).split('@')[0].toLowerCase() === local);
      if (sameMailbox) return ok(sameMailbox);
      if (opts.some(o => String(o).toLowerCase() === String(mine).toLowerCase())) return ok(mine);

      const real = opts.filter(o => !/privaterelay\.appleid\.com$/i.test(String(o)));
      if (real.length === 1) return ok(real[0], { probable: true });
      return park(
        `the form offers only ${opts.join(' | ')}, and none of them is ${mine} — ` +
        `confirm which address to use, or verify ${mine} on the account`
      );
    },
  },
  // A phone control whose options are countries is asking for the dialling code,
  // not the number. Feeding it the number can never match; feeding it the country
  // does — "South Africa" fits "South Africa (+27)" — so route on what is offered.
  {
    name: 'phone',
    test: /phone|mobile|cell|contact number|telephone/,
    resolve: (p, ctx) => {
      const opts = ctx.options || [];
      if (opts.length && opts.some(isDiallingCode)) {
        return p.identity.country
          ? ok(p.identity.country)
          : park('this is a country-code list and the profile has no country');
      }
      return ok(p.identity.phone);
    },
  },
  { name: 'city',      test: /^(current )?(city|town)$|city of residence|where.*located|current location/, resolve: p => ok(p.identity.city) },
  { name: 'country',   test: /^country$|country of residence/, resolve: p => ok(p.identity.country) },

  // ---- Links --------------------------------------------------------------
  { name: 'linkedin',  test: /linkedin/, resolve: p => ok(p.links.linkedin) },
  { name: 'github',    test: /github/, resolve: p => ok(p.links.github) },
  { name: 'portfolio', test: /portfolio|personal (web)?site|website|blog/, resolve: p => ok(p.links.portfolio) },

  // ---- Work authorisation — profile only, never inferred -------------------
  {
    name: 'sponsorship',
    test: /sponsor|visa|work permit/,
    resolve: (p, ctx) => {
      const a = authorisationFor(p, ctx.countryCode || 'ZA');
      if (!a.known) return park(`work authorisation question, but ${a.reason}`);
      // Asked as "do you need sponsorship" vs "are you authorised" — opposite polarity.
      const asksNeed = /require|need|sponsorship/.test(ctx.question.toLowerCase());
      return ok(asksNeed ? yesNo(a.requiresSponsorship, ctx) : yesNo(a.authorized, ctx));
    },
  },
  {
    name: 'authorized',
    test: /legally (authorized|authorised|eligible)|authorized to work|right to work|eligible to work/,
    resolve: (p, ctx) => {
      const a = authorisationFor(p, ctx.countryCode || 'ZA');
      if (!a.known) return park(`work authorisation question, but ${a.reason}`);
      return ok(yesNo(a.authorized, ctx));
    },
  },

  // ---- Years of experience — the highest-risk question ---------------------
  {
    name: 'yearsOfSkill',
    // A qualifier is allowed to sit between "years of" and "experience":
    // "Years of professional experience" is the same question as "Years of
    // experience", and without this it matched nothing, fell through to the model,
    // and the model is forbidden from answering years at all — so a question the
    // profile settles outright came back unanswerable.
    test: /how many years|years of (?:\w+[- ]){0,3}(experience|exp)\b|years.*experience (with|in|using)/,
    resolve: (p, ctx) => {
      // "Do you have 4-5 years of experience in digital marketing?" mentions years
      // but is a yes/no question, and answering it with a number fits no option and
      // parks. A control offering only yes/no is asking whether a threshold is met,
      // which is a comparison the profile's own total can settle.
      if (isYesNo(ctx.options)) {
        const meets = meetsYearsThreshold(p, ctx.question);
        if (meets == null) return park('a yes/no years question the profile cannot settle');
        return ok(yesNo(meets, ctx));
      }

      const skill = extractSkill(ctx.question);
      if (!skill) {
        const total = p.current?.confirmed ? p.current.totalYearsExperience : null;
        if (typeof total === 'number') return ok(String(total));
        return park('total years of experience is not confirmed in the profile');
      }
      const { value, reason, inferred } = skillYears(p, skill);
      if (value == null) return park(`years of experience with "${skill}" — ${reason}`);
      // A figure derived from the CV timeline answers the question, but is flagged
      // so it is seen once before an application carrying it submits itself.
      return ok(String(value), inferred ? { probable: true } : null);
    },
  },

  // ---- Logistics ----------------------------------------------------------
  {
    name: 'noticePeriod',
    // "When are you available to start?" parked live because the pattern read
    // "availability to start" and the form said "available to start". The answer
    // stays `${days} days` rather than prose: that is what the duration rule in
    // options.js fits onto "1 month" / "Less than 2 weeks" dropdowns, and prose
    // would fit nothing.
    test: /notice period|when (can|could|would) you (start|begin|commence)|availabilit(y|ies) to start|available to (start|commence|begin)|earliest (possible )?(start|available)|start date/,
    resolve: p => {
      if (!p.authorization?.confirmed) return park('notice period is not confirmed in the profile');
      return ok(`${p.authorization.noticePeriodDays} days`);
    },
  },
  {
    name: 'relocate',
    test: /willing to relocate|open to relocation|relocat/,
    resolve: (p, ctx) => {
      if (!p.authorization?.confirmed) return park('relocation preference is not confirmed');
      return ok(yesNo(p.authorization.willingToRelocate, ctx));
    },
  },
  { name: 'currentCompany', test: /current (employer|company)/, resolve: p => p.current?.confirmed ? ok(p.current.company) : park('current employer not confirmed') },
  { name: 'currentTitle',   test: /current (job )?title|current role|current position/, resolve: p => p.current?.confirmed ? ok(p.current.title) : park('current title not confirmed') },

  // ---- Compensation — explicitly unimportant, so never park on it ----------
  {
    name: 'compensation',
    test: /salary|compensation|remuneration|expected (pay|package)|ctc|rate expectation/,
    resolve: (p, ctx) => {
      // A control that will only take a number cannot take "Negotiable", so the
      // fallback text is not an answer there — it parked live applications. An
      // explicit expected figure is the only thing that satisfies those, and it is
      // the candidate's own number, never an inferred one.
      const expected = p.compensation?.expectedAnnual;
      const wantsNumber = ctx.fieldType === 'number' || /^(number|numeric)$/i.test(ctx.fieldType || '');
      if (wantsNumber) {
        return Number.isFinite(Number(expected))
          ? ok(String(Number(expected)))
          : park('a hard numeric salary figure is required, and compensation.expectedAnnual is not set');
      }
      return ok(p.compensation?.fallbackText || 'Negotiable');
    },
  },

  // ---- EEO / voluntary disclosure — always decline -------------------------
  {
    name: 'eeo',
    test: /gender|\brace\b|ethnic|veteran|disability|disabled|self[- ]identif|sexual orientation|pronoun/,
    resolve: (p, ctx) => {
      const opts = ctx.options || [];
      const decline = opts.find(o => /decline|prefer not|do not wish|choose not|not to (answer|say|disclose)/i.test(o));
      return ok(decline || 'Decline to self-identify');
    },
  },

  // ---- Misc ---------------------------------------------------------------
  { name: 'howDidYouHear', test: /how did you (hear|find|learn)|where did you (hear|find)|referral source/, resolve: p => ok(p.misc?.howDidYouHear || 'LinkedIn') },
  {
    name: 'driversLicence',
    test: /driver'?s? licen[sc]e/,
    resolve: (p, ctx) => typeof p.misc?.hasDriversLicense === 'boolean'
      ? ok(yesNo(p.misc.hasDriversLicense, ctx))
      : park('driver\'s licence status is not set in the profile'),
  },
];

/** Match the profile's boolean onto whatever the form actually offers. */
function yesNo(bool, ctx) {
  const opts = ctx.options || [];
  if (opts.length) {
    const want = bool ? /^yes\b|^true$|^i am|^i do/i : /^no\b|^false$|^i am not|^i do not/i;
    const hit = opts.find(o => want.test(o.trim()));
    if (hit) return hit;
  }
  return bool ? 'Yes' : 'No';
}

/**
 * Pull the technology out of "How many years of experience do you have with X?".
 * Returns null for a bare "years of experience" question, which routes to the
 * total instead.
 */
export function extractSkill(question) {
  // Drop trailing punctuation so the "skill sits at the end" pattern can anchor.
  const q = String(question).replace(/[?.!:]+\s*$/, '').trim();

  const m =
    // "...experience with SQL" / "...spent using Power BI" — skill runs to the end.
    q.match(/\b(?:with|in|using)\s+([^?.,;]+)$/i) ||
    // "...with SQL experience"
    q.match(/\b(?:with|in|using|of)\s+([^?.,;]+?)\s+(?:experience|exp)\b/i) ||
    // "SQL experience (years)"
    q.match(/^([^?.,;]+?)\s+(?:experience|exp)\s*\(?\s*years/i);
  if (!m) return null;

  const skill = m[1]
    .replace(/\b(do you have|experience|professional|hands[- ]on|working|commercial|total|your)\b/gi, ' ')
    // Strip a leading preposition left behind by the filler removal above —
    // otherwise "with SQL" reaches skillYears() and never matches anything.
    .replace(/^\s*(?:with|in|using|of|for|a|an|the)\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!skill || skill.length <= 1) return null;

  // "How many years of relevant full-time experience do you have?" is a question
  // about experience in general, but the pattern above happily returns the
  // qualifier "relevant full-time" as though it were a technology — which is then
  // looked up as a skill, never found, and parks. Two live applications died on
  // exactly that phrase. A qualifier is not a skill; returning null routes the
  // question to the confirmed total, which is what it was asking for.
  if (GENERIC_EXPERIENCE_QUALIFIERS.test(skill)) return null;

  return skill;
}

/**
 * Fold the punctuation real forms are written with onto the ASCII the matchers
 * are written in.
 *
 * Every pattern here uses a straight apostrophe, but ATS copy is typed in word
 * processors: "Do you have a valid driver’s licence?" carries U+2019, so
 * `/driver'?s? licen[sc]e/` never fired and a question the profile could answer
 * outright went to the model instead — which correctly declined it, because the
 * model is not allowed to assert a licence. One character cost the whole answer.
 */
export function normalisePunctuation(text) {
  return String(text)
    .replace(/[‘’ʼʹ′]/g, "'")   // curly / modifier apostrophes
    .replace(/[“”]/g, '"')                      // curly double quotes
    .replace(/[‐-―−]/g, '-')               // dashes and minus
    .replace(/ /g, ' ');                             // non-breaking space
}

/**
 * Strip the instruction a form wraps around the thing it is actually asking for.
 *
 * Several matchers are anchored (`/^(first|given)\s*name$/`), so "First name"
 * resolved from the profile while "Enter your first name" fell through to the
 * model — real applications burned LLM calls drafting a first name. The label is
 * the same question either way; only the politeness differs.
 */
export function stripImperative(q) {
  return String(q)
    .replace(/^\s*(please\s+)?(enter|type|input|provide|give|tell us|specify|add|fill in|write)\s+/i, '')
    .replace(/^\s*(your|the)\s+/i, '')
    .replace(/^\s*[*]\s*/, '')
    .trim();
}

export function matchProfile(profile, ctx) {
  const raw = normalisePunctuation(ctx.question || '').toLowerCase().trim();

  // The label as written wins, so nothing that matched before can change. The
  // stripped form is a second pass, not a substitute — it only adds matches the
  // anchored patterns would otherwise miss. `resolve` still sees the original
  // `ctx.question`, because polarity and threshold checks read the full wording.
  for (const q of [raw, stripImperative(raw)]) {
    if (!q) continue;
    for (const m of MATCHERS) {
      if (!m.test.test(q)) continue;
      return { matcher: m.name, ...m.resolve(profile, ctx) };
    }
    if (q === raw && stripImperative(raw) === raw) break;   // nothing to retry
  }
  return null;
}
