/**
 * Fabrication check for the covering letter.
 *
 * The CV pipeline has an evidence gate; the letter — the document a human reads
 * first — had none. The prompt forbids invention and nothing verified the
 * output. On 28 July that produced, for an amplify5 posting whose description
 * asks for Azure and Microsoft Fabric:
 *
 *   "My proficiency in SQL and familiarity with cloud technologies, including
 *    Azure, align well with the requirements..."
 *
 * Azure appears nowhere in the profile — it has generic `cloud platforms` and
 * never a named provider. The model closed the gap with the thing the employer
 * asked for. Every other claim in that letter verified; this one took a grep.
 *
 * The rule that matters: **the job description does not vouch for anything.**
 * The JD is where the invented term came from, so only the candidate's own
 * profile and evidence corpus may support a claim.
 */
import { corpus } from '../evidence/store.js';
import { normalisePunctuation } from '../answer/matchers.js';

/**
 * Capitalised words that start sentences or are ordinary English, and so say
 * nothing about the candidate's skills. Kept tight: the cost of a word missing
 * from this list is one needless regeneration, and the cost of over-listing is a
 * fabricated claim getting through.
 */
const STOPWORDS = new Set([
  'i', 'my', 'me', 'the', 'a', 'an', 'and', 'or', 'but', 'with', 'without', 'as', 'at', 'in', 'on', 'of', 'for', 'to',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'you', 'your', 'they', 'their',
  'additionally', 'furthermore', 'moreover', 'however', 'currently', 'recently', 'having', 'while', 'during',
  'dear', 'hiring', 'team', 'manager', 'kind', 'regards', 'sincerely', 'yours', 'best',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
  'excited', 'eager', 'keen', 'pleased', 'delighted', 'apply', 'application', 'position', 'role', 'job',
  'experience', 'background', 'skills', 'strong', 'proven', 'solid', 'foundation', 'proficiency', 'familiarity',
  'reference', 'notice', 'period', 'location', 'cv', 'resume', 'attached',
  'marketing', 'analytics', 'data', 'reporting', 'business', 'intelligence', 'engineering', 'analysis',
]);

/** Split a name/title into its meaningful lowercase tokens. */
const tokens = s => String(s || '').toLowerCase().match(/[a-z0-9.+#]{2,}/g) || [];

/**
 * Everything the candidate can legitimately be said to know.
 *
 * Profile skills, employers, job titles, education, certifications — plus the
 * full text of every evidence document. Deliberately NOT the job description.
 */
export function vouchingText(profile, docs = corpus()) {
  const parts = [];

  for (const name of Object.keys(profile.skills || {})) {
    if (!name.startsWith('_')) parts.push(name);
  }
  for (const e of profile.experience || []) parts.push(e.company, e.title, e.location, e.summary);
  for (const e of profile.education || []) parts.push(e.institution, e.degree, e.field);
  for (const c of profile.certifications || []) parts.push(c.name, c.issuer);
  parts.push(profile.current?.company, profile.current?.title);
  for (const d of docs) parts.push(d.text || '');

  return normalisePunctuation(parts.filter(Boolean).join(' \n ')).toLowerCase();
}

/**
 * Named things the letter asserts about the candidate.
 *
 * Proper nouns and product names — the class of claim that is checkable and that
 * a reader will take literally. Prose like "strong analytical skills" is not
 * extracted: it is unfalsifiable, and trying to police it would make the gate
 * fire on every letter.
 */
export function extractClaims(body) {
  const claims = new Set();

  // Sentence by sentence, so a phrase can never run across a full stop or a
  // paragraph break — "Microsoft Fabric.\n\nAdditionally" is two thoughts, not
  // one product name.
  for (const sentence of normalisePunctuation(body).split(/[.!?;:]+|\n+/)) {
    // Multi-word proper nouns and product names: "Power BI", "Google Analytics",
    // "Azure". Internal digits and dots allowed (GA4, Node.js). Single spaces
    // only — a newline is a boundary, not a separator.
    const re = /\b([A-Z][A-Za-z0-9.+#]*(?: +(?:[A-Z][A-Za-z0-9.+#]*|BI|AI|ML|SQL))*)\b/g;
    for (const m of sentence.matchAll(re)) {
      const phrase = m[1].trim().replace(/[,]+$/, '');
      if (phrase.length < 2) continue;
      // A phrase whose every token is a stopword says nothing — "Additionally",
      // "My", "Dear Hiring Team".
      const toks = tokens(phrase);
      if (!toks.length || toks.every(t => STOPWORDS.has(t))) continue;
      claims.add(phrase);
    }

    // Bare acronyms the pattern above may fold into a longer phrase.
    for (const m of sentence.matchAll(/\b([A-Z]{2,6}[0-9]?)\b/g)) {
      if (!STOPWORDS.has(m[1].toLowerCase())) claims.add(m[1]);
    }
  }

  return [...claims];
}

/**
 * Check every named claim in the letter against the profile and the corpus.
 *
 * `context` holds the things that appear in a letter for reasons other than
 * claiming a skill — the employer's name, the role title, the candidate's own
 * name. Those are not fabrications and must not be flagged.
 */
export function verifyCoverLetter(body, profile, { job = {}, docs = corpus() } = {}) {
  const haystack = vouchingText(profile, docs);

  const context = new Set([
    ...tokens(job.company), ...tokens(job.title),
    ...tokens(profile.identity?.firstName), ...tokens(profile.identity?.lastName),
    ...tokens(profile.identity?.city), ...tokens(profile.identity?.country),
  ]);

  // "amplify5" in the job record is written "Amplify 5" in prose, and a company
  // named in a letter is not a skill claim however it is spelled.
  const inContext = t => [...context].some(c => c === t || c.startsWith(t) || t.startsWith(c));

  const unvouched = [];
  for (const claim of extractClaims(body)) {
    const toks = tokens(claim);
    // Named for a reason other than claiming competence.
    if (toks.every(t => inContext(t) || STOPWORDS.has(t))) continue;
    // Vouched if the phrase appears, or if every one of its meaningful tokens
    // does — "Power BI" is covered by a profile listing "Microsoft Power BI".
    const lower = claim.toLowerCase();
    if (haystack.includes(lower)) continue;
    if (toks.every(t => STOPWORDS.has(t) || inContext(t) || haystack.includes(t))) continue;
    unvouched.push(claim);
  }

  return { ok: unvouched.length === 0, unvouched };
}
