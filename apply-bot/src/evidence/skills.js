/**
 * Is this a skill, does the candidate's own CV evidence it, and for how long?
 *
 * The skill queue is fed by a job-description *keyword* extractor, so most of what
 * arrives is not a skill at all — "feedback", "intellectual curiosity", "online
 * visibility", "numerical reasoning". Those built a 530-row queue, and a queue that
 * long stops being reviewed and starts being cleared, which is how 174 skills came
 * to be marked confirmed. Confirmed is what licenses the optimiser to write a skill
 * into a résumé, so the queue's noise became the résumé's risk.
 *
 * This module is the gate that noise never gets through:
 *
 *   not-a-skill   dropped, never queued, never asked about
 *   evidenced     auto-confirmed, with the line of the CV that proves it
 *   unevidenced   queued for the candidate to answer, as before
 *
 * The ladder is the one the answer resolver uses (`answer/resolver.js`):
 * deterministic rules first, a model only for what is left, and a deterministic
 * check on whatever the model says. A model may not classify something as a skill
 * that the stoplist rejects, and may not claim evidence it cannot quote.
 */
import { normaliseSkill } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';

// ---------------------------------------------------------------------------
// Is it a skill?
// ---------------------------------------------------------------------------

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Categories that are never skills, whatever a model thinks. Each is a thing an
 * employer cannot train you in or verify: a disposition, a working arrangement, a
 * number you influenced, a title you held, a qualification, a file format.
 *
 * These are patterns rather than a word list because the extractor invents new
 * phrasings constantly — "proactive mindset" today, "ownership mentality"
 * tomorrow — and a list would need editing after every run.
 */
const NOT_SKILL = [
  { why: 'a personal quality, not a skill', test: /\b(mindset|mentality|attitude|curiosity|passion|enthusias|motivat|proactiv|adaptab|flexib|reliab|resilien|integrity|initiative|ownership|attention to detail|detail.oriented|results?.(oriented|driven)|self.(starter|motivated)|team.(player|oriented)|hard.working|willingness)\b/ },
  { why: 'a soft skill, not a tool or technique', test: /\b(communicat|collaborat|collaborate|interpersonal|leadership|teamwork|problem.solv|critical thinking|analytical thinking|analytical skills|analytical reasoning|numerical reasoning|creative thinking|time management|organi[sz]ational skills|multi.task|written skills|verbal skills|writing skills|storytelling|work ethic|judgment|judgement|awareness)\b/ },
  { why: 'a working arrangement, not a skill', test: /^(remote|remote work|hybrid|on.?site|full.?time|part.?time|contract|permanent|freelance|shift work|relocation)$/ },
  { why: 'a market segment, not a skill', test: /^(b2b|b2c|b2b2c|saas|paas|iaas|enterprise|smb|startup|nonprofits?|agency|in.house)$/ },
  { why: 'a qualification, not a skill', test: /\b(bachelor|master|honours|honors|phd|doctorate|degree|diploma|matric|certificat(e|ion)s?|licence|license)\b/ },
  { why: 'a metric or outcome, not a skill', test: /^(kpis?|ctr|cpc|cpa|cac|cpl|cpm|roas|roi|mrr|arr|aov|ltv|nps)\b|\b(ctr decay|revenue growth|organic traffic|brand visibility|online visibility|predictive accuracy|data integrity|conversion rate|click.through|monetization|monetisation|market share|competitive positioning|benchmark performance)\b/ },
  { why: 'a file format, not a skill', test: /^(csv|xlsx?|xml|json|pdf|docx?|tsv|parquet|yaml)$/ },
  { why: 'a language proficiency, not a skill', test: /\b(english|afrikaans|zulu|xhosa|french|german|spanish|portuguese)\s+(proficiency|skills?|fluency|language)\b|^(fluent|bilingual|multilingual)\b/ },
  { why: 'a vague business phrase, not a skill', test: /^(technology|technologies|innovation|accuracy|charts?|datasets?|feedback|categori[sz]e|automate|troubleshooting|continuous improvement|cross.functional collaboration|stakeholder collaboration|business rules|business decision.making|data.driven decision.making|cloud.based|web.based tools|analytics solutions|data solutions|marketing (programs|tactics)|go.to.market strategies|configuration updates|validation processes|calibration exercises|monitoring and evaluation|source.to.target mappings|campaign assets|market intelligence|behavioral intelligence|commercial awareness|site functionality|user experience|web ux|optimization|optimisation)$/ },
];

// Products whose names end in a job-title word. Without these, "Google Tag
// Manager" and "Meta Ads Manager" — real tools this candidate uses daily — would
// be thrown out by the job-title rule below.
const TOOL_WITH_TITLE_SUFFIX = /\b(tag manager|ads manager|campaign manager 360|search console|business manager|data studio|power query|power automate)\b/;

const JOB_TITLE_SUFFIX = /\b(analyst|engineer|manager|specialist|consultant|scientist|expert|developer|director|coordinator|assistant|associate|officer|lead|intern|architect|administrator)$/;

/**
 * Deterministic verdict. Returns 'skill' only for things that are recognisably
 * tools; 'unknown' means "a model should look at this", not "yes".
 */
export function classifySkillDeterministic(term) {
  const t = norm(term);
  if (!t) return { verdict: 'not-a-skill', why: 'empty' };
  if (t.length < 2) return { verdict: 'not-a-skill', why: 'too short to be a skill' };
  if (t.split(' ').length > 5) return { verdict: 'not-a-skill', why: 'a sentence fragment, not a skill' };

  for (const rule of NOT_SKILL) {
    if (rule.test.test(t)) return { verdict: 'not-a-skill', why: rule.why };
  }
  if (JOB_TITLE_SUFFIX.test(t) && !TOOL_WITH_TITLE_SUFFIX.test(t)) {
    return { verdict: 'not-a-skill', why: 'a job title, not a skill' };
  }
  return { verdict: 'unknown', why: 'not settled by the deterministic rules' };
}

const CLASSIFY_SYSTEM = `You decide whether a term is a professional SKILL.

A SKILL is a named tool, platform, technology, programming language, framework, or
a specific, teachable technique or methodology. An employer could train someone in
it and could verify it.

NOT a skill: personal qualities and dispositions; soft skills; working
arrangements; market segments; job titles; qualifications and degrees; metrics and
business outcomes; file formats; language proficiency; vague business phrases.

Return JSON: {"verdicts": [{"term": "...", "skill": true|false}]}`;

/**
 * Classify a batch of candidate terms.
 *
 * The deterministic rules are the final word in the "no" direction: a model that
 * says "intellectual curiosity" is a skill does not get to overrule the stoplist.
 * With no key, undecided terms stay undecided and are queued — the same behaviour
 * as before this module existed, minus the noise the rules already caught.
 */
export async function classifySkills(terms, { callModel = callLLM, hasModel = hasKey } = {}) {
  const out = new Map();
  const unknown = [];

  for (const term of terms) {
    const d = classifySkillDeterministic(term);
    if (d.verdict === 'unknown') unknown.push(term);
    else out.set(term, d);
  }

  if (!unknown.length || !hasModel()) {
    for (const term of unknown) out.set(term, { verdict: 'unknown', why: 'no model available to classify' });
    return out;
  }

  // Chunked so a long list cannot blow the response budget, mirroring
  // resolver.js's chunkFields.
  for (let i = 0; i < unknown.length; i += 60) {
    const chunk = unknown.slice(i, i + 60);
    let res;
    try {
      res = await callModel([
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: `TERMS\n${JSON.stringify(chunk)}` },
      ], { maxTokens: 1500 });
    } catch {
      for (const term of chunk) out.set(term, { verdict: 'unknown', why: 'classification call failed' });
      continue;
    }

    const said = new Map((Array.isArray(res?.verdicts) ? res.verdicts : []).map(v => [norm(v.term), v.skill]));
    for (const term of chunk) {
      const v = said.get(norm(term));
      if (v === true) out.set(term, { verdict: 'skill', why: 'classified as a tool or technique' });
      else if (v === false) out.set(term, { verdict: 'not-a-skill', why: 'classified as not a skill' });
      else out.set(term, { verdict: 'unknown', why: 'model did not classify this term' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Does the CV evidence it?
// ---------------------------------------------------------------------------

const STEM_SUFFIXES = ['ations', 'ation', 'ment', 'ting', 'ing', 'tion', 'ised', 'ized', 'ers', 'ed', 'er', 's'];

const stem = w => {
  for (const s of STEM_SUFFIXES) if (w.length > s.length + 3 && w.endsWith(s)) return w.slice(0, -s.length);
  return w;
};

/**
 * Words of a document, each carrying its offset in the ORIGINAL text.
 *
 * Matching happens over tokens rather than over a normalised copy of the string,
 * because every match has to be reported back in terms of the real document: the
 * evidence quote is the line it sits on, and §4 attributes a mention to whichever
 * role section encloses it. Normalising the haystack shifts every offset, so a
 * quote would be cut from the wrong place and a skill credited to the wrong job.
 */
function tokenize(text) {
  const toks = [];
  const rx = /[a-z0-9+#.]+/gi;
  let m;
  while ((m = rx.exec(text))) {
    const raw = m[0].toLowerCase().replace(/\.+$/, '');
    if (raw) toks.push({ raw, stem: stem(raw), at: m.index });
  }
  return toks;
}

// Tokenising a CV is not free and the corpus is walked once per skill — 174
// skills across 3 documents is 522 passes over the same text otherwise.
const tokenCache = new Map();
function tokensOf(text) {
  let t = tokenCache.get(text);
  if (!t) {
    t = tokenize(text);
    if (tokenCache.size > 8) tokenCache.clear();
    tokenCache.set(text, t);
  }
  return t;
}

/** The line of the document a match sits on — that line is the evidence quote. */
function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 300);
}

/**
 * Find a phrase as a run of whole words. Whole-word is the point: a substring
 * search finds the skill "R" inside every word in the document, and "SEO" inside
 * "Seoul".
 */
function findPhraseAll(tokens, phrase, { stemmed = false } = {}) {
  const want = norm(phrase).split(' ').filter(Boolean).map(w => (stemmed ? stem(w) : w));
  if (!want.length) return [];
  const key = stemmed ? 'stem' : 'raw';
  const out = [];

  for (let i = 0; i + want.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (tokens[i + j][key] !== want[j]) { ok = false; break; }
    }
    if (ok) out.push(tokens[i].at);
  }
  return out;
}

const findPhrase = (tokens, phrase, opts) => {
  const all = findPhraseAll(tokens, phrase, opts);
  return all.length ? all[0] : -1;
};

/**
 * Locate a skill in one document, trying the name the candidate uses, the alias
 * map's canonical form, and any alias pointing at it — so a CV that says "Google
 * Analytics" evidences a profile skill recorded as "GA4".
 */
function spellings(skill) {
  const wanted = [norm(skill)];
  const canonical = normaliseSkill(skill);
  if (canonical && !wanted.includes(canonical)) wanted.push(canonical);
  for (const [alias, target] of Object.entries(ALIAS_REVERSE)) {
    if (target === canonical && !wanted.includes(alias)) wanted.push(alias);
  }
  return wanted.filter(Boolean);
}

/**
 * Every place a skill appears in one document.
 *
 * All of them, not just the first: a skill is typically listed in a "Skills:"
 * header AND used in a role's bullets, and it is the bullets that say how long it
 * was used for. Stopping at the first hit credits the skill to the header, where
 * there are no dates, and the duration is lost.
 */
function locateAll(skill, docText) {
  const tokens = tokensOf(docText);
  const out = [];
  for (const tier of ['literal', 'stemmed']) {
    for (const w of spellings(skill)) {
      for (const at of findPhraseAll(tokens, w, { stemmed: tier === 'stemmed' })) {
        if (!out.some(h => h.index === at)) out.push({ index: at, matched: w, tier });
      }
    }
    // A literal hit anywhere beats a stemmed one — don't dilute with near matches.
    if (out.length) break;
  }
  return out.sort((a, b) => a.index - b.index);
}

const locate = (skill, docText) => locateAll(skill, docText)[0] || null;

// Built from profile.js's alias map so both directions are searchable.
const ALIAS_REVERSE = {
  'google analytics': 'ga4', 'google analytics 4': 'ga4', gtm: 'google tag manager',
  'ms sql': 'microsoft sql server', powerbi: 'power bi', looker: 'looker studio', js: 'javascript',
};

const EVIDENCE_SYSTEM = `You decide which skills a résumé actually evidences.

You are given the full text of a candidate's résumé and a list of skills. For each
skill, decide whether the résumé shows the candidate has used or done it. The
skill does not have to be named literally — "built dashboards in Looker Studio"
evidences data visualisation. But an adjacent or aspirational mention does not
count: a résumé that says "worked alongside the data science team" does not
evidence machine learning.

For every skill you say is evidenced, quote the text from the résumé, VERBATIM,
that shows it. Copy the quote exactly — it is checked against the document.

Return JSON: {"evidenced": [{"skill": "...", "quote": "..."}], "absent": ["..."]}`;

/**
 * Find évidence for each skill across the corpus.
 *
 * @returns Map<skill, {verdict, quote, document, tier, why}>
 */
export async function findEvidence(skills, docs, { callModel = callLLM, hasModel = hasKey } = {}) {
  const out = new Map();
  const unresolved = [];

  for (const skill of skills) {
    let found = null;
    for (const doc of docs) {
      const hit = locate(skill, doc.text);
      if (!hit) continue;
      found = { verdict: 'evidenced', tier: hit.tier, document: doc.filename, quote: lineAt(doc.text, hit.index) };
      break;
    }
    if (found) out.set(skill, found);
    else unresolved.push(skill);
  }

  if (!unresolved.length || !docs.length || !hasModel()) {
    for (const skill of unresolved) {
      out.set(skill, { verdict: 'unevidenced', why: docs.length ? 'not found in any uploaded document' : 'no documents uploaded' });
    }
    return out;
  }

  // Semantic pass, one call per document, over only what the literal pass missed.
  for (const doc of docs) {
    const remaining = unresolved.filter(s => !out.has(s));
    if (!remaining.length) break;

    let res;
    try {
      res = await callModel([
        { role: 'system', content: EVIDENCE_SYSTEM },
        { role: 'user', content: `RÉSUMÉ (${doc.filename})\n${doc.text.slice(0, 12000)}\n\nSKILLS\n${JSON.stringify(remaining)}` },
      ], { maxTokens: 2000 });
    } catch { continue; }

    const hay = norm(doc.text);
    for (const item of Array.isArray(res?.evidenced) ? res.evidenced : []) {
      const skill = remaining.find(s => norm(s) === norm(item.skill));
      if (!skill || out.has(skill)) continue;

      // The guard: evidence that cannot be found in the document is not evidence.
      // A model that paraphrases, or invents a line, is discarded rather than
      // trusted — this is the control that keeps a claim traceable to the CV.
      const quote = String(item.quote || '').trim();
      if (!quote || !hay.includes(norm(quote))) continue;

      out.set(skill, { verdict: 'evidenced', tier: 'semantic', document: doc.filename, quote: quote.slice(0, 300) });
    }
  }

  for (const skill of unresolved) {
    if (!out.has(skill)) out.set(skill, { verdict: 'unevidenced', why: 'not found in any uploaded document' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// For how long?
// ---------------------------------------------------------------------------

const YEAR = /\b(19|20)\d{2}\b/;

/**
 * Where each role sits in a document, so a skill mention can be attributed to the
 * job it was used in. Roles are located by company name — the one string that is
 * both in the structured profile and printed in the CV.
 */
// Headings that end the experience section. Matched letter-by-letter with
// optional gaps, because CVs routinely letter-space their headings
// ("E D U C A T I O N"), and a plain /education/ finds nothing in those.
const AFTER_EXPERIENCE = ['education', 'certification', 'skills', 'references', 'projects', 'awards', 'interests', 'languages', 'publications', 'volunteer', 'achievements', 'courses', 'training'];

const spacedOut = word => new RegExp(`(^|\\n)[^\\S\\n]*${word.split('').join('\\s*')}`, 'i');

/**
 * Where the experience section stops.
 *
 * Without this the last role runs to the end of the document and swallows
 * Education and Certifications — so a "Google Analytics Certification" line gets
 * credited to whatever job happens to be listed last, and the derived span
 * stretches back to that job's start date. Observed on a real CV: GA4 was
 * attributed to a 2020–2021 construction role and only the total-experience cap
 * kept the answer from reading as six years.
 */
function experienceEnd(docText, after) {
  let end = docText.length;
  for (const word of AFTER_EXPERIENCE) {
    const m = spacedOut(word).exec(docText.slice(after));
    if (m && after + m.index < end) end = after + m.index;
  }
  return end;
}

function roleSections(profile, docText) {
  const tokens = tokensOf(docText);
  const marks = [];
  for (const role of profile.experience || []) {
    if (!role?.company) continue;
    const at = findPhrase(tokens, role.company);
    if (at !== -1) marks.push({ role, at });
  }
  marks.sort((a, b) => a.at - b.at);
  return marks.map((m, i) => ({
    role: m.role,
    from: m.at,
    to: i + 1 < marks.length ? marks[i + 1].at : experienceEnd(docText, m.at),
  }));
}

const yearOf = v => {
  const s = String(v ?? '');
  if (/present|current|now/i.test(s)) return new Date().getFullYear();
  const m = s.match(YEAR);
  return m ? Number(m[0]) : null;
};

/**
 * Years of a skill, derived from which roles mention it.
 *
 * Deliberately unwilling to produce a number:
 *  - only mentions that sit inside a role's section count, so a skill that appears
 *    solely in a "Skills:" list yields nothing — a keyword in a list is evidence
 *    of presence, not of duration;
 *  - the span is floored, never rounded up;
 *  - a span under a year yields nothing rather than 0 or a generous 1;
 *  - the result is capped at the candidate's stated total experience.
 *
 * @returns {{years: number|null, derivation: string, why?: string}}
 */
export function inferYears(skill, docs, profile) {
  const attributed = [];
  let best = null;

  for (const doc of docs) {
    const sections = roleSections(profile, doc.text);
    for (const hit of locateAll(skill, doc.text)) {
      const section = sections.find(s => hit.index >= s.from && hit.index < s.to);
      if (!section) continue;
      attributed.push(section.role);
      // The first mention inside a role is the better evidence quote: a bullet
      // describing the work beats the skills list at the top of the CV.
      if (!best) best = { quote: lineAt(doc.text, hit.index), document: doc.filename };
    }
  }

  if (!attributed.length) {
    return { years: null, derivation: '', why: 'mentioned only outside any role — presence, but no duration' };
  }

  const starts = attributed.map(r => yearOf(r.start)).filter(n => n != null);
  const ends = attributed.map(r => yearOf(r.end)).filter(n => n != null);
  if (!starts.length || !ends.length) {
    return { years: null, derivation: '', why: 'the roles mentioning it carry no usable dates' };
  }

  const from = Math.min(...starts);
  const to = Math.max(...ends);
  let years = Math.floor(to - from);

  const cap = profile.current?.totalYearsExperience;
  if (typeof cap === 'number' && years > cap) years = cap;

  if (years < 1) {
    return { years: null, derivation: '', why: 'the roles mentioning it span under a year' };
  }

  const seen = new Set();
  const parts = attributed.filter(r => !seen.has(r.company) && seen.add(r.company))
    .map(r => `${r.company} ${r.start}–${r.end}`);
  return { years, derivation: `${parts.join(', ')} → ${years}y`, ...(best || {}) };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Run candidate skills through the whole ladder.
 *
 * @returns {{drop: [], confirm: [], ask: []}}
 *   drop    — not skills; never queued, never asked about
 *   confirm — evidenced; caller writes them to the profile with their evidence
 *   ask     — real skills with no evidence; caller queues them as suggestions
 */
export async function gateSkills(terms, docs, profile, opts = {}) {
  const unique = [...new Set((terms || []).map(t => String(t).trim()).filter(Boolean))];
  const drop = [], confirm = [], ask = [];
  if (!unique.length) return { drop, confirm, ask };

  const classified = await classifySkills(unique, opts);
  const candidates = unique.filter(t => classified.get(t)?.verdict !== 'not-a-skill');
  for (const t of unique) {
    if (classified.get(t)?.verdict === 'not-a-skill') drop.push({ skill: t, why: classified.get(t).why });
  }
  if (!candidates.length) return { drop, confirm, ask };

  const evidence = await findEvidence(candidates, docs, opts);
  for (const skill of candidates) {
    const e = evidence.get(skill);
    if (e?.verdict !== 'evidenced') { ask.push({ skill, why: e?.why || 'no evidence found' }); continue; }
    const { years, derivation, why, quote, document } = inferYears(skill, docs, profile);
    confirm.push({
      skill,
      // Prefer the quote from inside a role — it describes the work, where the
      // literal pass may only have found the skills list at the top of the CV.
      evidence: { quote: quote || e.quote, document: document || e.document, tier: e.tier },
      years, derivation: derivation || why,
    });
  }
  return { drop, confirm, ask };
}

/**
 * Re-check skills already marked confirmed against the corpus. Report only — it
 * never writes. What it is for: 174 skills were confirmed while clearing a long
 * queue, and `confirmed` is what lets the optimiser write a skill into a résumé,
 * so knowing which of them the CV cannot support is the point.
 */
export async function auditConfirmedSkills(profile, docs, opts = {}) {
  const names = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m && typeof m === 'object' && m.confirmed)
    .map(([n]) => n);

  const classified = await classifySkills(names, opts);
  const evidence = await findEvidence(names, docs, opts);

  return names.map(name => {
    const meta = profile.skills[name];
    const cls = classified.get(name);
    const ev = evidence.get(name);
    return {
      skill: name,
      years: typeof meta.years === 'number' ? meta.years : null,
      source: meta.source || 'operator',
      isSkill: cls?.verdict !== 'not-a-skill',
      notSkillWhy: cls?.verdict === 'not-a-skill' ? cls.why : null,
      evidenced: ev?.verdict === 'evidenced',
      quote: ev?.quote || null,
      document: ev?.document || null,
    };
  });
}
