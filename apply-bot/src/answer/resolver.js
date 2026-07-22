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
 * Tiers 1–3 of the ladder: everything that resolves without a model.
 *
 * Split out so the batch resolver can exhaust the deterministic tiers first and
 * send only what is left to the model — the answer bank must keep winning over
 * the LLM, or a stored, human-verified answer would be re-drafted every form.
 *
 * Returns null when nothing deterministic applies.
 */
function resolveDeterministic(field, ctx) {
  const { question, fieldType = 'text', options = null, uid = null } = field;
  const base = { question, fieldType, options, uid };

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

  return null;
}

/**
 * The resolution ladder (plan §6.2). First hit wins; the tier that answered is
 * always recorded so a wrong answer can be traced to its source.
 *
 * Tier 5 is "park" — never a guess.
 */
export async function resolveField(field, ctx) {
  const { question, fieldType = 'text', options = null, required = true, uid = null } = field;
  const base = { question, fieldType, options, uid };

  const deterministic = resolveDeterministic(field, ctx);
  if (deterministic) return deterministic;

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

const BATCH_SYSTEM = `You fill in job application forms on behalf of one candidate.

You are given every remaining question on one form at once, and the candidate's
profile. Answer only the ones the profile actually supports.

You may ONLY use facts present in the CANDIDATE PROFILE. You have no other
knowledge about this person.

Rules, in order of importance:
1. If the profile does not contain the fact a question needs, put it in
   "unanswerable". Do not estimate, infer, approximate, or reason from context.
   Leaving a question out is always better than guessing at it.
2. NEVER produce a number of years of experience. Those are handled elsewhere.
3. NEVER answer a question about work authorisation, visa status, or citizenship.
4. NEVER claim a degree, certification, clearance, or licence not in the profile.
5. Where a question lists OPTIONS, the answer must be exactly one of them,
   copied character for character.
6. For open-ended questions (motivation, strengths, why this company), you MAY
   write prose grounded in the profile and the job description.

Return JSON:
{"fills": [{"uid": "...", "value": "..."}],
 "unanswerable": [{"uid": "...", "why": "<which fact is missing>"}]}`;

/** Roughly the serialised form size above which the call gets chunked. */
const BATCH_CHAR_BUDGET = 6000;

const serialiseField = f => ({
  uid: f.uid,
  question: f.question,
  type: f.fieldType,
  ...(f.options?.length ? { options: f.options } : {}),
  ...(f.required === false ? { optional: true } : {}),
  ...(f.node?.group ? { group: f.node.group } : {}),
});

/**
 * Split a form into calls that fit the budget, keeping fields in the same group
 * together — a question means something different out of the section it sits in.
 */
function chunkFields(fields, budget = BATCH_CHAR_BUDGET) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const f of fields) {
    const cost = JSON.stringify(serialiseField(f)).length;
    if (current.length && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function batchMap(fields, ctx) {
  const user = [
    `CANDIDATE PROFILE\n${summariseForLLM(ctx.profile)}`,
    ctx.jobTitle ? `\nROLE: ${ctx.jobTitle} at ${ctx.company}` : '',
    ctx.jd ? `\nJOB DESCRIPTION (excerpt)\n${String(ctx.jd).slice(0, 2500)}` : '',
    `\nFORM FIELDS\n${JSON.stringify(fields.map(serialiseField), null, 1)}`,
  ].filter(Boolean).join('\n');

  const out = await callLLM([
    { role: 'system', content: BATCH_SYSTEM },
    { role: 'user', content: user },
  ], { maxTokens: 2000 });

  return {
    fills: Array.isArray(out.fills) ? out.fills : [],
    unanswerable: Array.isArray(out.unanswerable) ? out.unanswerable : [],
  };
}

/**
 * Resolve a whole form with one model call instead of one per field.
 *
 * Per-field drafting costs 15–20 calls on a long form and shows the model each
 * question stripped of its context. Batching cuts that to one or two and lets the
 * model see the whole form, which measurably helps on ambiguous fields.
 *
 * It changes nothing about what is trusted. The deterministic tiers still run
 * first and still win, every returned value still goes through `guardAnswer()`,
 * an option not on the offered list still parks, and a field the model skips
 * still parks. The model chooses values; it never chooses to bypass a control.
 */
export async function resolveFormBatch(rawFields, ctx) {
  // Every field needs a stable handle, because that is how the model's answers
  // are matched back to controls. Both collectors supply one; this is insurance
  // against a caller that does not, since duplicate undefined uids would silently
  // collapse into a single entry.
  const fields = rawFields.map((f, i) => (f.uid ? f : { ...f, uid: `field-${i}` }));

  const resolved = [];
  const parked = [];
  const needsModel = [];

  const park = (field, tier, reason) => {
    const r = {
      status: 'park', tier, reason,
      question: field.question, fieldType: field.fieldType,
      options: field.options, uid: field.uid,
    };
    resolved.push(r);
    if (field.required !== false) parked.push(r);
  };

  for (const field of fields) {
    const hit = resolveDeterministic(field, ctx);
    if (!hit) { needsModel.push(field); continue; }
    resolved.push(hit);
    if (hit.status === 'park' && field.required !== false) parked.push(hit);
  }

  if (!needsModel.length) return finishForm(resolved, parked);

  if (!hasKey()) {
    for (const f of needsModel) {
      park(f, 'none', f.required === false
        ? 'optional field left unanswered'
        : 'no profile fact, no stored answer, and no LLM key');
    }
    return finishForm(resolved, parked);
  }

  for (const chunk of chunkFields(needsModel)) {
    let mapping;
    try {
      mapping = await batchMap(chunk, ctx);
    } catch (err) {
      for (const f of chunk) park(f, 'llm-error', `LLM call failed: ${err.message}`);
      continue;
    }

    const byUid = new Map(chunk.map(f => [f.uid, f]));
    const said = new Set();

    for (const fill of mapping.fills) {
      const field = byUid.get(fill.uid);
      if (!field) continue;            // a uid we never asked about
      said.add(fill.uid);

      const value = fill.value;
      if (value == null || value === '') {
        park(field, 'llm', 'model returned an empty answer');
        continue;
      }

      // A select or radio answer must be one of the offered options. Forcing a
      // near-miss into the control would either fail or pick the wrong one.
      if (field.options?.length) {
        const exact = field.options.find(o => String(o).toLowerCase().trim() === String(value).toLowerCase().trim());
        if (!exact) {
          park(field, 'llm', `model returned "${String(value).slice(0, 60)}", which is not one of: ${field.options.join(' | ')}`);
          continue;
        }
        const check = guardAnswer(field.question, exact, ctx);
        if (!check.ok) { park(field, 'llm-rejected', check.reason); continue; }
        resolved.push({
          status: 'ok', tier: 'llm', value: exact,
          question: field.question, fieldType: field.fieldType, options: field.options, uid: field.uid,
        });
        continue;
      }

      // The deterministic control on anything a model produced. A prompt is not
      // a control, so this runs on batch output exactly as it does per field.
      const check = guardAnswer(field.question, value, ctx);
      if (!check.ok) { park(field, 'llm-rejected', check.reason); continue; }

      resolved.push({
        status: 'ok', tier: 'llm', value,
        question: field.question, fieldType: field.fieldType, options: field.options, uid: field.uid,
      });
    }

    for (const entry of mapping.unanswerable) {
      const field = byUid.get(entry.uid);
      if (!field || said.has(entry.uid)) continue;
      said.add(entry.uid);
      park(field, 'llm', entry.why || 'model could not answer from the profile');
    }

    // A field the model simply did not mention is not an answered field.
    for (const field of chunk) {
      if (!said.has(field.uid)) park(field, 'llm', 'model returned no answer for this field');
    }
  }

  return finishForm(resolved, parked);
}

const finishForm = (resolved, parked) => ({
  resolved,
  parked,
  ok: parked.length === 0,
  tiers: resolved.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {}),
});

/**
 * Resolve a whole form one field at a time.
 *
 * Superseded by `resolveFormBatch`, which both adapters now use — a long form
 * cost 15–20 model calls this way and showed the model each question stripped of
 * its context. Kept because it is the fallback shape if batching ever needs
 * disabling for a vendor, and because it is the simplest statement of what the
 * ladder does.
 */
export async function resolveForm(fields, ctx) {
  const resolved = [];
  const parked = [];

  for (const field of fields) {
    const r = await resolveField(field, ctx);
    resolved.push(r);
    if (r.status === 'park' && (field.required !== false)) parked.push(r);
  }

  return finishForm(resolved, parked);
}

export { normaliseQuestion, saveAnswer };
