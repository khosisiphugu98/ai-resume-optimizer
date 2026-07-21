import { matchProfile, extractSkill } from './matchers.js';
import { lookupExact, lookupFuzzy, saveAnswer, recordUse, normaliseQuestion } from './bank.js';
import { skillYears, authorisationFor, summariseForLLM } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';

const SYSTEM = `You fill in job application forms on behalf of one candidate.

You may ONLY use facts present in the CANDIDATE PROFILE below. You have no other
knowledge about this person.

Rules, in order of importance:
1. If the profile does not contain the fact needed, return UNANSWERABLE. Do not
   estimate, infer, approximate, or reason from context.
2. NEVER produce a number of years of experience. Those are handled elsewhere.
3. NEVER answer a question about work authorisation, visa status, or citizenship.
4. NEVER claim a degree, certification, clearance, or licence not in the profile.
5. For open-ended questions (motivation, strengths, why this company), you MAY
   write prose grounded in the profile and the job description.

Return JSON: {"answer": "<text>"} or {"unanswerable": "<what fact is missing>"}`;

/**
 * The resolution ladder (plan §6.2). First hit wins; the tier that answered is
 * always recorded so a wrong answer can be traced to its source.
 *
 * Tier 5 is "park" — never a guess.
 */
export async function resolveField(field, ctx) {
  const { question, fieldType = 'text', options = null, required = true } = field;
  const base = { question, fieldType, options };

  // Tier 1 — deterministic profile lookup
  const hit = matchProfile(ctx.profile, { ...base, countryCode: ctx.countryCode, question });
  if (hit?.park) return { status: 'park', tier: 'profile', reason: hit.park, ...base };
  if (hit?.value != null && hit.value !== '') {
    return { status: 'ok', tier: 'profile', matcher: hit.matcher, value: hit.value, ...base };
  }

  // Tier 2 — answer bank, exact
  const exact = lookupExact(question, ctx);
  if (exact) {
    recordUse(exact.id);
    return { status: 'ok', tier: 'bank-exact', value: exact.answer_value, answerId: exact.id, ...base };
  }

  // Tier 3 — answer bank, fuzzy. Applied, but flagged so review can catch it.
  const fuzzy = lookupFuzzy(question, ctx);
  if (fuzzy) {
    recordUse(fuzzy.id);
    return {
      status: 'ok', tier: 'bank-fuzzy', value: fuzzy.answer_value,
      answerId: fuzzy.id, similarity: fuzzy.similarity, probable: true, ...base,
    };
  }

  // Tier 4 — LLM draft, hard-constrained
  if (hasKey()) {
    try {
      const drafted = await draftAnswer(question, fieldType, options, ctx);
      if (drafted.value != null) {
        const check = guardAnswer(question, drafted.value, ctx);
        if (check.ok) return { status: 'ok', tier: 'llm', value: drafted.value, ...base };
        // The model produced something the deterministic guard rejects. Park —
        // a prompt is not a control.
        return { status: 'park', tier: 'llm-rejected', reason: check.reason, ...base };
      }
      return { status: 'park', tier: 'llm', reason: drafted.unanswerable || 'model could not answer from the profile', ...base };
    } catch (err) {
      return { status: 'park', tier: 'llm-error', reason: `LLM call failed: ${err.message}`, ...base };
    }
  }

  // Tier 5 — park
  return {
    status: 'park', tier: 'none', ...base,
    reason: required ? 'no profile fact, no stored answer, and no LLM key' : 'optional field left unanswered',
  };
}

async function draftAnswer(question, fieldType, options, ctx) {
  const user = [
    `CANDIDATE PROFILE\n${summariseForLLM(ctx.profile)}`,
    ctx.jobTitle ? `\nROLE: ${ctx.jobTitle} at ${ctx.company}` : '',
    ctx.jd ? `\nJOB DESCRIPTION (excerpt)\n${String(ctx.jd).slice(0, 2500)}` : '',
    `\nQUESTION: ${question}`,
    `FIELD TYPE: ${fieldType}`,
    options?.length ? `OPTIONS (answer must be exactly one): ${options.join(' | ')}` : '',
  ].filter(Boolean).join('\n');

  const out = await callLLM([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ], { maxTokens: 600 });

  if (out.unanswerable) return { value: null, unanswerable: out.unanswerable };
  let value = out.answer;
  // A select/radio answer must be one of the offered options.
  if (options?.length && !options.includes(value)) {
    const near = options.find(o => o.toLowerCase().trim() === String(value).toLowerCase().trim());
    if (!near) return { value: null, unanswerable: `model returned "${value}", not one of the offered options` };
    value = near;
  }
  return { value };
}

/**
 * Deterministic post-check on anything a model produced. Prompt instructions are
 * guidance; this is the actual control (plan §6.3).
 */
export function guardAnswer(question, value, ctx) {
  const q = String(question).toLowerCase();
  const v = String(value);

  // Years of experience must trace to a confirmed skills[].years entry.
  if (/how many years|years of (experience|exp)/.test(q)) {
    const skill = extractSkill(question);
    if (!skill) {
      const total = ctx.profile.current?.confirmed ? ctx.profile.current.totalYearsExperience : null;
      if (String(total) !== v.trim()) {
        return { ok: false, reason: `model answered "${v}" for total years of experience; profile says ${total ?? 'unconfirmed'}` };
      }
      return { ok: true };
    }
    const { value: years } = skillYears(ctx.profile, skill);
    if (years == null) return { ok: false, reason: `model answered a years question about "${skill}", which is not confirmed in the profile` };
    if (!v.includes(String(years))) return { ok: false, reason: `model answered "${v}" but the profile says ${years} years of ${skill}` };
    return { ok: true };
  }

  // Authorisation answers must come from the profile, never a model.
  if (/sponsor|visa|authorized to work|authorised to work|right to work|work permit|citizen/.test(q)) {
    const a = authorisationFor(ctx.profile, ctx.countryCode || 'ZA');
    if (!a.known) return { ok: false, reason: 'model answered a work authorisation question, which only the profile may answer' };
    return { ok: false, reason: 'work authorisation must resolve from the profile, not the model' };
  }

  // No claiming credentials that aren't in the profile.
  if (/\b(degree|certified|certification|clearance|licen[sc]e)\b/.test(q) && /^(yes|true)$/i.test(v.trim())) {
    const certs = (ctx.profile.certifications || []).map(c => c.name).join(' ').toLowerCase();
    const edu = (ctx.profile.education || []).map(e => `${e.degree} ${e.field}`).join(' ').toLowerCase();
    const mentioned = q.split(/\s+/).some(w => w.length > 4 && (certs.includes(w) || edu.includes(w)));
    if (!mentioned) return { ok: false, reason: 'model asserted a credential not evidenced in the profile' };
  }

  return { ok: true };
}

/** Resolve a whole form. Parks the application if any required field parks. */
export async function resolveForm(fields, ctx) {
  const resolved = [];
  const parked = [];

  for (const field of fields) {
    const r = await resolveField(field, ctx);
    resolved.push(r);
    if (r.status === 'park' && (field.required !== false)) parked.push(r);
  }

  return {
    resolved,
    parked,
    ok: parked.length === 0,
    tiers: resolved.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {}),
  };
}

export { normaliseQuestion, saveAnswer };
