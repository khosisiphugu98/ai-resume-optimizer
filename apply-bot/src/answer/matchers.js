import { skillYears, authorisationFor, normaliseSkill } from '../profile.js';

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
    const { value } = yearsForPhrase(profile, skill);
    return typeof value === 'number' ? value >= need : false;
  }

  const total = profile.current?.confirmed ? profile.current.totalYearsExperience : null;
  return typeof total === 'number' ? total >= need : null;
}

/**
 * "South Africa (+27)" — the shape of a country-code option.
 *
 * The parentheses are one vendor's house style, not the format. Meridial's list
 * reads `United States +1 | Afghanistan +93 | ... | South Africa +27`, which the
 * parenthesised pattern missed entirely: the control was not recognised as a
 * dialling-code list, `identity.country` went in as a bare "South Africa", no
 * option matched, and a live application parked. Match the code wherever it sits
 * in the label, bracketed or not.
 */
const isDiallingCode = opt => /\(?\+\d{1,4}\)?(\s|$)/.test(String(opt).trim());
const isEmailLike = opt => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(opt).trim());

/**
 * A label that says the form will email *you*, rather than asking for your
 * address.
 *
 * On the Agoda submission, "Email me about other job openings within the Booking
 * Holding's entities and recruitment-related newsletters" was answered
 * `mksiphugu@gmail.com` at tier `profile` — the email matcher fires on the word
 * "email" and had no way to tell a request for an address from an offer to send
 * marketing. The candidate was opted into a recruitment newsletter by a keyword
 * match. Same shape as the city-vs-country overlap: the matcher declines a label
 * that merely contained its word.
 */
const EMAIL_IS_AN_OFFER =
  /\b(e-?mail|text|contact|notify|inform|update|send|keep)\s+me\b|\bnewsletter|\bmailing list\b|\bsubscribe|\bopt[- ]?in\b|\bjob alerts?\b|\bmarketing (e-?mail|communication|material)|\bpromotional\b|\b(would you like to|do you want to|happy to)\s+(receive|be)\b|\breceive\s+(e-?mails?|updates|communications|news|information)\b/i;

/**
 * Tier 1 of the resolution ladder — deterministic profile lookups. Anything
 * matched here never reaches a model.
 *
 * Order matters: the years-of-experience matcher must come before generic
 * numeric matchers, and EEO before anything that mentions "identify".
 */
/**
 * The address to use on this channel.
 *
 * `identity.email` is the monitored mailbox and the default everywhere.
 * `identity.linkedinEmail`, when set, is the address LinkedIn has verified on
 * the account — used only for Easy Apply, where the form offers a fixed list
 * and the profile address is not on it.
 */
export function channelEmail(p, ctx = {}) {
  const linkedin = p.identity?.linkedinEmail;
  return (ctx.ats === 'linkedin' && linkedin) ? linkedin : p.identity?.email;
}

/**
 * The kinds of permission a form asks for, and the profile key that settles each.
 *
 * Ordered narrowest-first: a marketing opt-in and an SMS opt-in are both worded
 * as data permissions, so the specific reading has to be tried before the
 * general one.
 *
 * `fallback` is the answer when the profile says nothing, and it is the
 * privacy-preserving one in every case but `dataProcessing`. Consenting to have
 * your application read is what applying *is* — answering "no" there would
 * withdraw the application in the act of making it — whereas nothing about
 * applying requires agreeing to a newsletter, an SMS list, or having your CV
 * passed to third parties.
 */
export const CONSENT_KINDS = [
  {
    key: 'marketingEmail',
    fallback: false,
    what: 'marketing email about other roles',
    test: /\b(e-?mail|contact|notify|inform|send|keep)\s+me\b|\bnewsletter|\bmailing list\b|\bsubscribe\b|\bjob alerts?\b|\bmarketing (e-?mail|communication|material)|\bpromotional\b|\breceive\s+(e-?mails?|updates|communications|news)\b/i,
  },
  {
    key: 'smsUpdates',
    fallback: false,
    what: 'text message / SMS updates',
    test: /\b(text|sms|whatsapp)\b.{0,40}\b(update|message|alert|notification|communication)|\breceive\s+(text|sms)\b|\btext\/sms\b/i,
  },
  {
    key: 'talentPool',
    fallback: false,
    what: 'keeping your details on file for future roles',
    test: /\btalent (pool|community|network|pipeline)\b|\b(keep|retain|store|hold|save)\b.{0,40}\b(details|data|cv|resume|résumé|profile|application|record)\b.{0,50}\b(future|other|further|later|upcoming)\b|\bconsider(ed)?\b.{0,30}\b(other|future|similar)\s+(roles?|positions?|opportunit|vacanc)/i,
  },
  {
    key: 'dataSharing',
    fallback: false,
    what: 'sharing your personal data with third parties',
    test: /\bthird[- ]part(y|ies)\b|\b(share|shared|sharing|disclose|disclosed|transfer|transferred|provide)\b.{0,60}\b(partners?|affiliates?|group companies|other entities|subsidiar|vendors?|agents?|clients?)\b/i,
  },
  {
    key: 'dataProcessing',
    fallback: true,
    what: 'processing your application data',
    test: /\b(consent|agree|permission|authorise|authorize|acknowledge)\b.{0,80}\b(process|processing|use|using|collect|collection|stor(e|ing|age)|retain|handling)\b.{0,40}\b(personal (data|information)|my (data|information)|your (data|information))\b|\bprivacy (policy|notice|statement)\b|\bdata protection\b|\bpopia\b|\bgdpr\b/i,
  },
];

/** What the profile says about one kind of permission, or null when unset. */
export function consentPreference(profile, key) {
  const v = profile?.consent?.[key];
  return typeof v === 'boolean' ? v : null;
}

/**
 * Attestations about the candidate's relationships and conflicts of interest.
 *
 * Not consent and not preference — statements of fact with legal weight, about
 * things the profile does not record. Agoda asked the same auditor-independence
 * question on two postings in one batch: the model answered "No" on one and
 * parked on the other. Neither was a decision anyone made. These always park, so
 * the operator answers once and the answer bank carries it everywhere after.
 */
const ATTESTATION =
  /\bindependent auditor\b|\bauditor independence\b|\bimpairment of\b.{0,40}\bauditor\b|\bconflicts? of interest\b|\brelated[- ]part(y|ies)\b|\b(are|is) (you|any)\b.{0,60}\b(related to|relative of|family member of)\b.{0,40}\b(employee|director|officer|shareholder)\b/i;

export const MATCHERS = [
  // ---- Consent and attestation — first, deliberately ------------------------
  //
  // These run ahead of everything else because the cost of a looser matcher
  // winning is not a wrong answer in a field, it is a permission granted on the
  // candidate's behalf. "Email me about other job openings" was answered with an
  // email address; two legally meaningful consents were answered "Yes" by a
  // language model with nothing in the profile behind either. A consent question
  // is answered from the consent block or it is not answered.
  {
    name: 'consent',
    // Built from the kinds themselves rather than written out again. A separate
    // broad pattern is a second place to keep in step, and it was already out of
    // step on the first attempt: "May we keep your details on file for future
    // roles?" matched the talent-pool kind and never reached it, because the
    // gate in front of it mentioned none of those words.
    test: new RegExp(CONSENT_KINDS.map(k => `(?:${k.test.source})`).join('|'), 'i'),
    resolve: (p, ctx) => {
      const q = ctx.question || '';
      const kind = CONSENT_KINDS.find(k => k.test.test(q));
      if (!kind) return null;   // a word overlapped; this is not a permission question

      const stated = consentPreference(p, kind.key);
      if (stated != null) return ok(yesNo(stated, ctx));

      // Nothing in the profile. Take the privacy-preserving answer rather than
      // asking a model to have a preference on the candidate's behalf, and flag
      // it so it is seen once and can be settled in the profile for good.
      return ok(yesNo(kind.fallback, ctx), { probable: true });
    },
  },
  {
    name: 'attestation',
    test: ATTESTATION,
    resolve: () => park(
      'this is a legal attestation about relationships or conflicts of interest, ' +
      'and the profile records no answer — answer it once here and it will be reused'),
  },

  // ---- Identity -----------------------------------------------------------
  { name: 'firstName', test: /^(first|given)\s*name$|^forename/, resolve: p => ok(p.identity.firstName) },
  { name: 'lastName',  test: /^(last|family|sur)\s*name$|^surname/, resolve: p => ok(p.identity.lastName) },
  { name: 'fullName',  test: /^(full|legal)?\s*name$|your name/, resolve: p => ok(`${p.identity.firstName} ${p.identity.lastName}`) },
  // An email control that offers a fixed list is not asking which address to type,
  // it is asking which of these addresses is yours — LinkedIn only offers the ones
  // verified on the account. The profile address is frequently not among them, and
  // string equality against the list can only fail. Match on the mailbox instead,
  // and otherwise prefer a real address over an Apple private-relay alias.
  //
  // Which address is "mine" depends on the channel. LinkedIn holds the iCloud
  // address and offers only what it has verified, so that is the one an Easy
  // Apply carries; everywhere else the Gmail address is used, because that is
  // the mailbox the reply-watcher reads. Sending the iCloud address to an
  // external ATS would mean the employer's reply lands somewhere nothing is
  // watching, and the application reads as one that was never followed up.
  {
    name: 'email',
    test: /e[- ]?mail/,
    resolve: (p, ctx) => {
      // "Email me about other openings" is not asking for an address. Declining
      // lets the search continue to the consent matcher below, which is where a
      // marketing opt-in actually belongs.
      if (EMAIL_IS_AN_OFFER.test(ctx.question || '')) return null;

      const mine = channelEmail(p, ctx);
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
  // Country first, and city explicitly declines anything that says "country".
  // A LinkedIn field labelled "Country: Current Location" was answered "Pretoria"
  // because the city matcher owns "current location" and ran first — a correct
  // fact in the wrong control, which then fails the option list and parks the
  // application. The more specific word wins.
  { name: 'country',   test: /\bcountry\b|nationality of residence/, resolve: p => ok(p.identity.country) },
  {
    name: 'city',
    test: /^(current )?(city|town)$|city of residence|where.*located|current location|city\/town/,
    resolve: (p, ctx) => (/\bcountry\b/i.test(ctx.question || '') ? null : ok(p.identity.city)),
  },

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
      const hit = yearsForPhrase(p, skill);
      if (hit.value == null) return park(`years of experience with "${skill}" — ${hit.reason}`);
      // A figure derived from the CV timeline, from a related skill entry, or from
      // the candidate's field rather than the exact phrase asked about, answers the
      // question — but is flagged so it is seen once before an application
      // carrying it submits itself unattended.
      return ok(String(hit.value), hit.exact ? null : { probable: true });
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

// ---------------------------------------------------------------------------
// Years of experience in a *field*, as opposed to with a *tool*.
//
// The matcher used to be punished for succeeding. Extracting nothing from
// "How many years of experience do you have?" routed the question to the
// confirmed total and answered it; extracting something the profile does not
// list verbatim parked it with no fallback. LinkedIn's screener questions name a
// domain rather than a tool — "Marketing and Advertising", "Online Media",
// "data analysis and data profiling" — so the better the extractor worked, the
// more applications died. Three of this channel's parks on 28 July were that,
// and one required park abandons the whole application.
//
// The distinction that has to be preserved is domain versus tool. A Marketing
// Data Analyst with three confirmed years can answer "how many years of
// Marketing experience"; nobody can answer "how many years of Kubernetes" from
// that same fact. Both sides of the line are derived from the profile itself
// rather than from a list somebody has to maintain.
// ---------------------------------------------------------------------------

/** How many distinct confirmed skills must carry a word before it reads as a field. */
const DOMAIN_SKILL_SPREAD = 3;

/**
 * Adjectives that describe the medium or the seriousness of work, not its
 * subject. "Digital Marketing" is Marketing; "Online Media" is Media. Dropping
 * these narrows nothing, and keeping them fails a domain the candidate plainly
 * works in on a word that carries no content.
 */
const NON_NARROWING = new Set([
  'online', 'digital', 'general', 'overall', 'broad', 'commercial', 'professional',
  'practical', 'direct', 'modern', 'core', 'full', 'related', 'relevant', 'applicable',
  'hands', 'on', 'end', 'strategic', 'operational',
]);

const PHRASE_STOPWORDS = new Set([
  'and', 'or', 'with', 'in', 'of', 'for', 'the', 'a', 'an', 'to', 'at', 'as', 'by',
  'using', 'use', 'work', 'working', 'experience', 'exp', 'years', 'year', 'your',
  'you', 'do', 'have', 'has', 'role', 'roles', 'field', 'area', 'industry', 'sector',
  'environment', 'environments', 'space', 'domain', 'discipline',
]);

const wordsOf = text => String(text).toLowerCase().split(/[^a-z0-9+#]+/i).filter(Boolean);

/** The words in a phrase that actually name something. */
function contentWords(phrase) {
  return wordsOf(phrase).filter(w => w.length >= 3 && !PHRASE_STOPWORDS.has(w) && !NON_NARROWING.has(w));
}

/**
 * Two words naming the same thing.
 *
 * A five-character prefix is enough morphology for the cases that come up —
 * analysis/analytics/analytical, market/marketing, advertise/advertising — and
 * short enough to write down. Words under six characters must match outright,
 * because a five-letter prefix of a five-letter word is the word.
 */
const sameWord = (a, b) =>
  a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 5) === b.slice(0, 5));

/** Every word the candidate's own job titles and fields of study are made of. */
function roleWords(profile) {
  const text = [
    profile.current?.title,
    ...(profile.experience || []).map(e => e.title),
    ...(profile.education || []).map(e => e.field),
  ].filter(Boolean).join(' ');
  return wordsOf(text).filter(w => w.length >= 3 && !PHRASE_STOPWORDS.has(w));
}

/** word → how many distinct confirmed skills mention it. */
function skillWordSpread(profile) {
  const spread = new Map();
  for (const [name, meta] of Object.entries(profile.skills || {})) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object' || !meta.confirmed) continue;
    for (const w of new Set(wordsOf(name))) {
      if (w.length < 3) continue;
      spread.set(w, (spread.get(w) || 0) + 1);
    }
  }
  return spread;
}

/**
 * Whether a phrase names the field the candidate works in.
 *
 * Two independent kinds of evidence, and every content word needs one of them:
 * the word appears in their own job titles or fields of study, or it runs across
 * enough separate confirmed skills to be a subject rather than a product. A tool
 * shows up once — `AWS` is one entry, `Kubernetes` is none — while a field shows
 * up everywhere: `data` spans a dozen skills, `analysis` several more.
 *
 * That asymmetry is the whole control. "How many years of AWS?" still parks even
 * though AWS is a confirmed skill, because one entry is not a career.
 */
export function isDomainPhrase(profile, phrase) {
  const words = contentWords(phrase);
  if (!words.length) return false;

  const roles = roleWords(profile);
  const spread = skillWordSpread(profile);

  return words.every(w =>
    roles.some(r => sameWord(r, w)) ||
    (spread.get(w) || 0) >= DOMAIN_SKILL_SPREAD);
}

/** "Marketing and Advertising" → ["Marketing", "Advertising"]. */
const splitCompound = phrase => String(phrase)
  .split(/\s+(?:and|&|\+)\s+|\s*\/\s*|\s*,\s*/i)
  .map(s => s.trim())
  .filter(s => s.length > 1);

/**
 * Words that name no subject of their own, so a skill entry ending in one is the
 * same skill as the entry without it. "Data analysis techniques" is data
 * analysis; "marketing technology" is not marketing.
 */
const GENERIC_SKILL_SUFFIX = new Set([
  'technique', 'techniques', 'tool', 'tools', 'skill', 'skills', 'software',
  'method', 'methods', 'methodology', 'methodologies', 'principle', 'principles',
  'fundamentals', 'practice', 'practices', 'concepts', 'knowledge', 'expertise',
  'experience', 'work', 'ability', 'abilities', 'basics',
]);

/**
 * A confirmed skill that says the same thing the question asked, with a years
 * figure on it.
 *
 * Deliberately hard to satisfy, because the two obvious looser rules are both
 * wrong in the same direction — they let a number that is true of something
 * narrow answer a question about something broad. Matching a skill *inside* the
 * question would let three years of "Power BI" answer "Power BI Premium".
 * Matching the question anywhere inside a skill would let four years of
 * "App Marketing" answer "how many years of Marketing" — which is what it did
 * on the first run of this code.
 *
 * So the question must be the *start* of the skill's name, and everything the
 * skill adds after it must be a word that narrows nothing.
 */
function skillYearsBySubstring(profile, phrase) {
  const want = normaliseSkill(phrase);
  if (want.length < 4) return null;
  for (const [name, meta] of Object.entries(profile.skills || {})) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object') continue;
    const have = normaliseSkill(name);
    if (have === want || !have.startsWith(`${want} `)) continue;
    const tail = have.slice(want.length).trim().split(/\s+/);
    if (!tail.every(w => GENERIC_SKILL_SUFFIX.has(w))) continue;
    if (!meta.confirmed || typeof meta.years !== 'number') continue;
    return { value: meta.years, name, inferred: meta.yearsSource === 'inferred' };
  }
  return null;
}

/**
 * Years of experience with whatever the question named.
 *
 * The ladder, narrowest first: the phrase as a confirmed skill; each half of a
 * compound phrase as one; a confirmed skill that says something more specific;
 * and finally the candidate's confirmed total, but only when the phrase names
 * their field rather than a tool.
 *
 * `exact` marks the first rung. Everything below it answered a question slightly
 * different from the one asked, so the caller flags it for review.
 */
export function yearsForPhrase(profile, phrase) {
  const direct = skillYears(profile, phrase);
  if (typeof direct.value === 'number') {
    return { value: direct.value, exact: !direct.inferred, reason: null };
  }

  const parts = splitCompound(phrase);
  const candidates = parts.length > 1 ? [phrase, ...parts] : [phrase];

  for (const part of parts.length > 1 ? parts : []) {
    const hit = skillYears(profile, part);
    if (typeof hit.value === 'number') return { value: hit.value, exact: false, reason: null };
  }

  for (const part of candidates) {
    const hit = skillYearsBySubstring(profile, part);
    if (hit) return { value: hit.value, exact: false, reason: null };
  }

  const total = profile.current?.confirmed ? profile.current.totalYearsExperience : null;
  if (typeof total === 'number') {
    for (const part of candidates) {
      if (isDomainPhrase(profile, part)) return { value: total, exact: false, reason: null };
    }
  }

  // Nothing fit. Report the most specific reason available — the direct lookup's,
  // which names the skill, rather than a generic miss.
  return {
    value: null,
    exact: false,
    reason: `${direct.reason}, and it does not name a field the profile's own titles, studies or skills cover`,
  };
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
      // A matcher may look at the full question and decline — returning null means
      // "this is not mine after all", so the search continues rather than stopping
      // on a pattern that merely overlapped.
      const res = m.resolve(profile, ctx);
      if (!res) continue;
      return { matcher: m.name, ...res };
    }
    if (q === raw && stripImperative(raw) === raw) break;   // nothing to retry
  }
  return null;
}
