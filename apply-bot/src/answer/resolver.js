import { matchProfile, extractSkill } from './matchers.js';
import { lookupExact, lookupFuzzy, saveAnswer, recordUse, normaliseQuestion } from './bank.js';
import { matchOption } from './options.js';
import { skillYears, authorisationFor, summariseForLLM } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';

const SYSTEM = `You fill in job application forms on behalf of one candidate.

Use the candidate's structured PROFILE and the full text of their RÉSUMÉ as your
evidence, and apply ordinary common sense to what they say.

Rules, in order of importance:
1. Ground every answer in the PROFILE or the RÉSUMÉ. You MAY reason and infer
   from them, but you may NOT invent a fact that appears in neither. If the answer
   isn't there or reasonably derivable, return UNANSWERABLE.
2. NEVER produce a number of years of experience. Those are handled elsewhere.
3. NEVER answer a question about work authorisation, visa status, or citizenship.
4. NEVER claim a degree, certification, clearance, or licence not evidenced in the
   profile or the résumé.
5. For open-ended questions (motivation, strengths, why this company), you MAY
   write prose grounded in the résumé and the job description.

Return JSON: {"answer": "<text>"} or {"unanswerable": "<what fact is missing>"}`;

/**
 * Why a field's question cannot be trusted, or null when it reads fine.
 *
 * Three shapes, all seen in production. An empty name means labelling failed
 * outright. A name identical to one of the control's own options means the
 * accessible name fell through to the control's content — "Yes" as both the
 * question and the answer. A one- or two-character name carries no meaning a
 * person could act on, let alone a model.
 */
export function unreadableQuestion(field) {
  const q = String(field?.question ?? '').trim();
  if (!q) return 'the field has no readable label';
  if (q.length < 3) return `the field's label is just "${q}" — too short to be a question`;

  const opts = (field?.options || []).map(o => String(o).trim().toLowerCase());
  if (opts.length && opts.includes(q.toLowerCase())) {
    return `the label "${q}" is one of the control's own options, so the real question was never read`;
  }
  return null;
}

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

  /**
   * Fit a resolved value onto the options the control actually offers.
   *
   * A profile fact is stated in the profile's words, not the form's: the notice
   * period is "30 days" and the dropdown offers "1 month", the confirmed skill is
   * "3" years and the dropdown offers "3-5 years". Passing the profile's wording
   * straight through means `fillField` throws mid-application, so an answer that
   * was known and correct is lost to a vocabulary mismatch.
   *
   * A value that cannot be fitted parks instead of being forced into the nearest
   * option — the option list is the full set of claims the form will accept, and
   * none of them being true is exactly what review exists to handle.
   */
  const fit = result => {
    if (!options?.length || result.value == null || result.value === '') return result;
    const m = matchOption(result.value, options, { semantic: true });
    if (!m) {
      return {
        status: 'park', tier: `${result.tier}-option`, ...base,
        reason: `"${String(result.value).slice(0, 60)}" is not one of: ${options.join(' | ')}`,
      };
    }
    if (m.rule === 'exact') return result;
    return {
      ...result, value: m.option, rawValue: result.value, optionRule: m.rule,
      probable: result.probable || !m.confident,
    };
  };

  // Tier 1 — deterministic profile lookup.
  //
  // A park here is held, NOT returned. The profile states a fact in the profile's
  // own words, and a control may simply not offer that wording: LinkedIn's "Email
  // address" is a select of account-verified addresses, and a phone-country-code
  // list never contains a phone number. Returning the park immediately made tiers
  // 2 and 3 unreachable in exactly the case they exist for — a human had already
  // stored the right answer for "Email address" and it was never once read
  // (`times_used` stayed 0 while the question parked ten times). So the ladder
  // continues, and the tier-1 park is only the answer if nothing below resolves.
  let deferredPark = null;

  // `ats` rides along because a few answers are channel-dependent — the email
  // address in particular: LinkedIn offers only the addresses it has verified.
  const hit = matchProfile(ctx.profile, { ...base, countryCode: ctx.countryCode, ats: ctx.ats, question });
  if (hit?.park) {
    deferredPark = { status: 'park', tier: 'profile', reason: hit.park, ...base };
  } else if (hit?.value != null && hit.value !== '') {
    const fitted = fit({
      status: 'ok', tier: 'profile', matcher: hit.matcher, value: hit.value, ...base,
      ...(hit.probable ? { probable: true } : {}),
    });
    if (fitted.status !== 'park') return fitted;
    deferredPark = fitted;   // the profile knew a value; the control would not take it
  }

  // Tier 2 — answer bank, exact
  const exact = lookupExact(question, ctx);
  if (exact) {
    const fitted = fit({ status: 'ok', tier: 'bank-exact', value: exact.answer_value, answerId: exact.id, ...base });
    if (fitted.status !== 'park') { recordUse(exact.id); return fitted; }
  }

  // Tier 3 — answer bank, fuzzy. Applied, but flagged so review can catch it.
  const fuzzy = lookupFuzzy(question, ctx);
  if (fuzzy) {
    const fitted = fit({
      status: 'ok', tier: 'bank-fuzzy', value: fuzzy.answer_value,
      answerId: fuzzy.id, similarity: fuzzy.similarity, probable: true, ...base,
    });
    if (fitted.status !== 'park') { recordUse(fuzzy.id); return fitted; }
  }

  // Nothing below tier 1 could satisfy the control either. Now the park stands —
  // and it reports the profile's reason, which is the one the operator can act on.
  return deferredPark;
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

  // Same rule as the batch path: an unreadable question is never answered.
  const unreadable = unreadableQuestion(field);
  if (unreadable) return { status: 'park', tier: 'unreadable', reason: unreadable, ...base };

  const deterministic = resolveDeterministic(field, ctx);
  if (deterministic) return deterministic;

  // Tier 4 — LLM draft, hard-constrained
  if (hasKey()) {
    try {
      const drafted = await draftAnswer(question, fieldType, options, ctx);
      if (drafted.value != null) {
        const check = guardAnswer(question, drafted.value, ctx);
        if (check.ok) return { status: 'ok', tier: 'llm', value: drafted.value, ...base, ...(drafted.probable ? { probable: true } : {}) };
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
    ctx.resumeText ? `\nRÉSUMÉ (extracted text)\n${String(ctx.resumeText).slice(0, 6000)}` : '',
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
  // A select/radio answer must be one of the offered options — a near miss is
  // fitted onto the list, and anything that will not fit parks.
  if (options?.length && !options.includes(value)) {
    const m = matchOption(value, options, { semantic: true });
    if (!m) return { value: null, unanswerable: `model returned "${value}", not one of the offered options` };
    value = m.option;
    if (!m.confident) return { value, probable: true };
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

  // Authorisation, nationality and citizenship are matters of legal fact. They
  // resolve from the profile or they do not resolve — a model may not state them
  // however plausible its inference. Both outcomes below are a refusal on purpose;
  // the caller parks, and the matcher answers the question on the next pass once
  // the profile carries the fact.
  if (/sponsor|visa|authorized to work|authorised to work|right to work|work permit|citizen|nationality/.test(q)) {
    return { ok: false, reason: 'work authorisation, citizenship and nationality resolve from the profile, not the model' };
  }

  // No claiming credentials that aren't evidenced.
  //
  // Two holes this used to have. It only fired on a bare "yes", so "Yes, I hold a
  // valid licence" walked straight past it; and it accepted the claim if ANY word
  // over four characters from the question appeared anywhere in the résumé, which
  // on a full CV is nearly always true — "do you have a *relevant* degree" passed
  // because "relevant" appeared somewhere. Now the affirmative is recognised in
  // prose, and the evidence has to be the credential itself.
  if (/\b(degree|certified|certification|clearance|licen[sc]e|qualification|accredited)\b/.test(q) && isAffirmative(v)) {
    const certs = (ctx.profile.certifications || []).map(c => c.name).join(' ').toLowerCase();
    const edu = (ctx.profile.education || []).map(e => `${e.degree} ${e.field}`).join(' ').toLowerCase();
    const resume = String(ctx.resumeText || '').toLowerCase();
    const haystack = `${certs} ${edu} ${resume}`;

    // The nouns the question is actually about, not every long word in it.
    const subject = q
      .replace(/\b(do|does|did|you|your|have|has|a|an|the|any|is|are|in|of|for|with|valid|current|please|confirm|indicate)\b/g, ' ')
      .split(/[^a-z0-9+#.]+/i)
      .filter(w => w.length > 3);

    const evidenced = subject.length > 0 && subject.some(w => haystack.includes(w));
    if (!evidenced) {
      return { ok: false, reason: `model asserted "${v.slice(0, 40)}" for a credential not evidenced in the profile or résumé` };
    }
  }

  // Where the candidate lives is a fact, not an inference. With identity.city
  // empty the model filled a City control with "South Africa" on one live
  // application and invented "Johannesburg" on another; nothing checked either.
  if (/^(current |home )?(city|town)\b|city of residence|which city|where do you (live|reside)/.test(q)) {
    const city = ctx.profile.identity?.city;
    if (!city) return { ok: false, reason: 'model supplied a city, but identity.city is empty in the profile' };
    if (!normalise(v).includes(normalise(city))) {
      return { ok: false, reason: `model answered "${v}" for city; the profile says ${city}` };
    }
  }

  // A salary figure is a negotiating position, never a guess.
  if (/salary|compensation|remuneration|expected (pay|package)|ctc/.test(q) && /\d/.test(v)) {
    const expected = ctx.profile.compensation?.expectedAnnual;
    if (expected == null) {
      return { ok: false, reason: 'model produced a salary figure, but compensation.expectedAnnual is not set' };
    }
    const digits = v.replace(/\D/g, '');
    if (digits && !digits.includes(String(expected)) && !String(expected).includes(digits)) {
      return { ok: false, reason: `model answered "${v}"; the profile expects ${expected}` };
    }
  }

  return { ok: true };
}

const normalise = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "Yes", "Yes, I do", "I have one", "true" — an affirmative in any dress. */
function isAffirmative(value) {
  const v = String(value).trim().toLowerCase();
  if (/^(yes|y|true|correct|affirmative|i do|i have|i am)\b/.test(v)) return true;
  return /^(yes|true)$/i.test(v);
}

const BATCH_SYSTEM = `You fill in job application forms on behalf of one candidate.

You are given every remaining question on one form at once, plus the candidate's
structured PROFILE and the full text of their RÉSUMÉ. Use both as your evidence,
and apply ordinary common sense to what they say.

Rules, in order of importance:
1. Ground every answer in the PROFILE or the RÉSUMÉ. You MAY reason and infer
   from them — derive a strength from the experience listed, judge fit from the
   role, answer a practical yes/no that plainly follows from the facts. What you
   may NOT do is invent facts that appear in neither source. If a question needs a
   fact you cannot find or reasonably derive, put it in "unanswerable". A confident,
   well-grounded answer is better than a needless "unanswerable"; a guess at a fact
   that isn't there is worse than either.
2. NEVER produce a number of years of experience. Those are handled elsewhere.
3. NEVER answer a question about work authorisation, visa status, or citizenship.
4. NEVER claim a degree, certification, clearance, or licence unless the PROFILE
   or the RÉSUMÉ actually shows it.
5. Where a question lists OPTIONS, the answer must be exactly one of them,
   copied character for character.
6. For open-ended questions (motivation, strengths, why this company), write
   concise prose grounded in the résumé and the job description.

Return JSON:
{"fills": [{"uid": "...", "value": "..."}],
 "unanswerable": [{"uid": "...", "why": "<which fact is missing>"}]}`;

/**
 * Roughly the serialised form size above which the call gets chunked.
 *
 * Lowered from 6000. The user message also carries up to 6000 characters of
 * résumé and 2500 of job description, so a full-budget chunk left the model
 * holding a great deal at once — and what it did under that load was quietly omit
 * fields from its reply rather than answer them badly. Smaller chunks and the
 * retry below address the same failure from both ends.
 */
const BATCH_CHAR_BUDGET = 3500;

/** The model that fills form fields. See the note at the callLLM site below. */
const BATCH_MODEL = 'gpt-4o';

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
    ctx.resumeText ? `\nRÉSUMÉ (extracted text)\n${String(ctx.resumeText).slice(0, 6000)}` : '',
    ctx.jobTitle ? `\nROLE: ${ctx.jobTitle} at ${ctx.company}` : '',
    ctx.jd ? `\nJOB DESCRIPTION (excerpt)\n${String(ctx.jd).slice(0, 2500)}` : '',
    `\nFORM FIELDS\n${JSON.stringify(fields.map(serialiseField), null, 1)}`,
  ].filter(Boolean).join('\n');

  const out = await callLLM([
    { role: 'system', content: BATCH_SYSTEM },
    { role: 'user', content: user },
    // gpt-4o-mini is the default for the cheap, high-volume calls elsewhere, but
    // this one has to return a complete object covering every field it was given,
    // and the smaller model demonstrably dropped entries from long replies —
    // 22 of 30 model-tier parks in production were fields it never mentioned.
    // Answers go on real applications; this is the wrong place to save a fraction
    // of a cent.
  ], { maxTokens: 4000, model: BATCH_MODEL });

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
    // A question we could not read is not a question we may answer.
    //
    // When accessible-name resolution finds nothing it can fall back to the
    // control's own content, so a lone checkbox came back with the question text
    // "Yes" — and one live application agreed to three separate terms whose
    // wording nobody ever saw. Everything else in this module is built on knowing
    // what was asked; when that is not true, the only safe answer is none.
    const unreadable = unreadableQuestion(field);
    if (unreadable) { park(field, 'unreadable', unreadable); continue; }

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

      const settled = settleModelValue(field, fill.value, ctx);
      resolved.push(settled);
      if (settled.status === 'park' && field.required !== false) parked.push(settled);
    }

    for (const entry of mapping.unanswerable) {
      const field = byUid.get(entry.uid);
      if (!field || said.has(entry.uid)) continue;
      said.add(entry.uid);
      park(field, 'llm', entry.why || 'model could not answer from the profile');
    }

    // A field the model simply did not mention is not an answered field — but it
    // is not necessarily an unanswerable one either.
    //
    // This was the single largest LLM failure in production: 22 of 30 model-tier
    // parks were "returned no answer", and they included questions the profile
    // plainly settles ("In which country do you currently work?"). The model was
    // not declining, it was losing track of items in a long batch. So the dropped
    // fields get one focused second pass, asked on their own, before they park.
    const dropped = chunk.filter(f => !said.has(f.uid));
    if (dropped.length) {
      const recovered = await retryDropped(dropped, ctx);
      for (const field of dropped) {
        const value = recovered.get(field.uid);
        if (value == null || value === '') {
          park(field, 'llm', 'model returned no answer for this field, twice');
          continue;
        }
        const settled = settleModelValue(field, value, ctx);
        resolved.push(settled);
        if (settled.status === 'park' && field.required !== false) parked.push(settled);
      }
    }
  }

  return finishForm(resolved, parked);
}

/**
 * Put one model-produced value through every control that applies to it.
 *
 * Shared by the batch pass and the retry pass so a recovered answer is subject to
 * exactly the same scrutiny as a first-pass one — a second chance to answer is not
 * a second standard of proof.
 */
function settleModelValue(field, value, ctx) {
  const base = {
    question: field.question, fieldType: field.fieldType,
    options: field.options, uid: field.uid,
  };
  const park = (tier, reason) => ({ status: 'park', tier, reason, ...base });

  if (value == null || value === '') return park('llm', 'model returned an empty answer');

  // A select or radio answer must be one of the offered options. The model is told
  // to copy one character for character and mostly does; when it answers correctly
  // in its own words ("1 month" for a "30 days" option) the value is fitted onto
  // the list, and an interpreted fit is flagged for review. What will not fit at
  // all still parks — forcing a near miss into the control would either fail or
  // pick the wrong one.
  if (field.options?.length) {
    const m = matchOption(value, field.options, { semantic: true });
    if (!m) {
      return park('llm', `model returned "${String(value).slice(0, 60)}", which is not one of: ${field.options.join(' | ')}`);
    }
    const check = guardAnswer(field.question, m.option, ctx);
    if (!check.ok) return park('llm-rejected', check.reason);
    return {
      status: 'ok', tier: 'llm', value: m.option, ...base,
      ...(m.rule === 'exact' ? {} : { rawValue: String(value), optionRule: m.rule }),
      ...(m.confident ? {} : { probable: true }),
    };
  }

  // The deterministic control on anything a model produced. A prompt is not a
  // control, so this runs on batch output exactly as it does per field.
  const check = guardAnswer(field.question, value, ctx);
  if (!check.ok) return park('llm-rejected', check.reason);

  return { status: 'ok', tier: 'llm', value, ...base };
}

/**
 * Ask again for the fields the batch response left out entirely.
 *
 * One call, only the dropped fields, so the model has far less to hold in view.
 * A failure here is not fatal — the caller parks whatever comes back empty, which
 * is what would have happened anyway.
 */
async function retryDropped(fields, ctx) {
  const out = new Map();
  try {
    const mapping = await batchMap(fields, ctx);
    for (const fill of mapping.fills || []) {
      if (fill?.uid != null) out.set(fill.uid, fill.value);
    }
  } catch { /* the caller parks these; a failed retry changes nothing */ }
  return out;
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
