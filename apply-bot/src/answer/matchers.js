import { skillYears, authorisationFor } from '../profile.js';

const ok = value => ({ value, source: 'profile' });
const park = reason => ({ park: reason });

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
  { name: 'email',     test: /e[- ]?mail/, resolve: p => ok(p.identity.email) },
  { name: 'phone',     test: /phone|mobile|cell|contact number|telephone/, resolve: p => ok(p.identity.phone) },
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
    test: /how many years|years of (experience|exp)|years.*experience (with|in|using)/,
    resolve: (p, ctx) => {
      const skill = extractSkill(ctx.question);
      if (!skill) {
        const total = p.current?.confirmed ? p.current.totalYearsExperience : null;
        if (typeof total === 'number') return ok(String(total));
        return park('total years of experience is not confirmed in the profile');
      }
      const { value, reason } = skillYears(p, skill);
      if (value == null) return park(`years of experience with "${skill}" — ${reason}`);
      return ok(String(value));
    },
  },

  // ---- Logistics ----------------------------------------------------------
  {
    name: 'noticePeriod',
    test: /notice period|when can you start|availability to start|start date/,
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
      if (ctx.fieldType === 'number') return park('a hard numeric salary figure is required');
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
  return skill && skill.length > 1 ? skill : null;
}

export function matchProfile(profile, ctx) {
  const q = String(ctx.question || '').toLowerCase().trim();
  for (const m of MATCHERS) {
    if (!m.test.test(q)) continue;
    const res = m.resolve(profile, ctx);
    return { matcher: m.name, ...res };
  }
  return null;
}
