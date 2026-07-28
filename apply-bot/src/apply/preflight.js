/**
 * The last look before anything reaches an employer.
 *
 * Every other control in this system runs at the moment a value is decided, on
 * one field, with no view of the rest. This one runs once, at the end, over the
 * whole payload — the point where a person would read it back before pressing
 * send.
 *
 * It exists because of what the 28 July run put out. Both applications that
 * reached employers carried something nobody had checked: the literal string
 * "unanswerable" typed into a free-text box, and "Advanced Excel" chosen from an
 * option list against a profile that says intermediate. Neither was catchable at
 * the field level — the first had no option list to fail against, and the second
 * was a perfectly valid option that simply was not true.
 *
 * The division of labour is deliberate and is the whole point:
 *
 *   Claude reads and objects.  It sees the profile and the payload and says what
 *                              looks wrong. It is given no way to supply a value
 *                              — the schema has no field for one.
 *   This module decides.       An objection blocks or it does not, on rules
 *                              written here.
 *
 * That is the same shape as the rest of the pipeline: the model is used for
 * judgement about text, and deterministic code holds every decision. A check
 * that cannot run — no key, an API error — never blocks. Refusing to send
 * because the reviewer was unreachable would turn an outage into a lost
 * application, and the deterministic half below runs either way.
 */
import { matchProfile, CONSENT_KINDS, consentPreference } from '../answer/matchers.js';
import { matchOption } from '../answer/options.js';
import { isNonAnswer } from '../answer/resolver.js';
import { summariseForLLM } from '../profile.js';
import { callClaude, hasAnthropicKey } from '../llm-anthropic.js';
import { getSetting } from '../db.js';
import { emit } from '../bus.js';

/** Off only if an operator turns it off. */
export function preflightEnabled() {
  return getSetting('preflight_enabled', '1') !== '0';
}

/**
 * Matchers whose answer is a plain fact about the candidate, where a value that
 * disagrees with the profile is a defect rather than a judgement call.
 *
 * Deliberately not every matcher. `compensation` fits a fallback string onto
 * whatever a form offers and `howDidYouHear` is a preference, so a difference
 * there is noise; a different surname is not.
 */
const HARD_FACT_MATCHERS = new Set([
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'country', 'city',
  'sponsorship', 'authorized', 'yearsOfSkill', 'consent', 'linkedin', 'github',
]);

/**
 * Matchers whose answer changes depending on what the control offered.
 *
 * A phone control whose choices are countries is asking for a dialling code, so
 * the same question yields "South Africa" with the list and the candidate's
 * phone number without it. When a record does not carry its options there is no
 * way to re-derive which question was really being asked, and guessing produced
 * a false objection to every correct country-code answer. Silence is right here:
 * an unverifiable field is not a wrong one.
 */
const OPTION_DEPENDENT = new Set(['phone', 'email', 'eeo']);

const objection = (severity, question, value, why) =>
  ({ severity, question: String(question ?? ''), value: String(value ?? ''), why });

/** 'yes', 'no' or null — the polarity of an answer, however it is worded. */
function polarityOf(value) {
  const m = matchOption(value, ['Yes', 'No']);
  if (!m) return null;
  return m.option === 'Yes' ? 'yes' : 'no';
}

/**
 * Everything checkable without a model. Runs always, key or no key.
 *
 * @returns objection[]
 */
export function deterministicObjections({ filled = [], profile, ats = null, countryCode = 'ZA' } = {}) {
  const out = [];

  for (const f of filled) {
    const question = f.question ?? '';
    const value = f.value;
    if (value == null || value === '' || f.kind === 'file') continue;

    // A refusal written as an answer. The resolver rejects these at both model
    // paths and the wizard rejects them again before typing, so reaching here
    // means something bypassed both — which is exactly when a third check earns
    // its place.
    if (isNonAnswer(value)) {
      out.push(objection('block', question, value,
        'this is the system\'s own word for "I cannot answer this", not an answer'));
      continue;
    }

    // What the profile would have said, asked fresh — with the options the
    // control offered, because several matchers answer differently without them.
    // A phone control whose choices are countries is asking for a dialling code,
    // so the same question yields "South Africa" with the list and the
    // candidate's phone number without it. Re-asking blind reported every
    // correct country-code answer as a contradiction.
    let expected = null;
    try {
      expected = matchProfile(profile, { question, options: f.options || null, countryCode, ats });
    } catch { /* a matcher that throws is not evidence of anything */ }

    const checkable = expected?.value != null && expected.value !== ''
      && HARD_FACT_MATCHERS.has(expected.matcher)
      && !(OPTION_DEPENDENT.has(expected.matcher) && !f.options);

    if (checkable) {
      // The value that went in may be the profile's answer fitted onto the
      // option list — "South Africa" landing in "South Africa +27". A semantic
      // fit is still the same answer.
      const fits = matchOption(expected.value, [String(value)], { semantic: true });
      if (!fits) {
        out.push(objection('block', question, value,
          `the profile answers this "${expected.value}" (${expected.matcher})`));
        continue;
      }
    }

    // A permission granted against the candidate's stated preference. The
    // matcher settles these deterministically now, so this catches a value that
    // arrived from anywhere else — a stale answer-bank entry, an operator pin,
    // a board's own prefill.
    const kind = CONSENT_KINDS.find(k => k.test.test(question));
    if (kind) {
      const want = consentPreference(profile, kind.key) ?? kind.fallback;
      const said = polarityOf(value);
      if (said && said !== (want ? 'yes' : 'no')) {
        out.push(objection('block', question, value,
          `${kind.what}: the profile says ${want ? 'yes' : 'no'}, and this answers ${said}`));
      }
    }
  }

  return out;
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objections'],
  properties: {
    objections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'value', 'why', 'severity'],
        properties: {
          question: { type: 'string' },
          value: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['block', 'note'] },
        },
      },
    },
  },
};

const REVIEW_SYSTEM = `You are the last check on a job application that is about to be submitted on a real person's behalf. You are reviewing it, not writing it.

You are given the candidate's PROFILE and every ANSWER the system is about to send. Report what is wrong with the answers. You cannot change them and you are not asked to suggest replacements — there is nowhere in your response to put one.

Mark an objection "block" when, and only when:
- the answer states something the profile does not support, or overstates it (a proficiency level above what the profile records, a tool or platform the profile does not list, a qualification it does not show);
- the answer contradicts the profile;
- the answer grants a permission, consent or subscription;
- the answer is plainly not a response to the question asked, or is a placeholder, an error message, or a note to self;
- the answer is written to a different employer or a different role than the one named.

Mark everything else "note": a clumsy phrasing, a thin but true answer, a stylistic preference. Notes do not stop the application, so do not use "block" for something you merely dislike.

An answer that is true, grounded in the profile, and responsive to the question needs no objection at all. Most applications should come back with an empty list.`;

/** Ask Claude to read the payload back. Never throws; an unreachable check objects to nothing. */
async function modelObjections({ filled, profile, job, subject = null, body = null }, callFn) {
  const answers = filled
    .filter(f => f.kind !== 'file' && f.value != null && f.value !== '')
    .map(f => ({ question: f.question ?? '', value: String(f.value), decidedBy: f.tier ?? '?' }));

  if (!answers.length && !body) return [];

  const user = [
    `CANDIDATE PROFILE\n${summariseForLLM(profile)}`,
    job ? `\nAPPLYING FOR: ${job.title} at ${job.company}` : '',
    answers.length ? `\nANSWERS ABOUT TO BE SENT\n${JSON.stringify(answers, null, 1)}` : '',
    subject ? `\nEMAIL SUBJECT\n${subject}` : '',
    body ? `\nEMAIL BODY\n${body}` : '',
  ].filter(Boolean).join('\n');

  const out = await callFn([{ role: 'user', content: user }], {
    system: REVIEW_SYSTEM, schema: REVIEW_SCHEMA,
  });
  return Array.isArray(out?.objections) ? out.objections : [];
}

/**
 * Check a payload before it is sent.
 *
 * @returns {{ ok, blocked, notes, reason }} — `reason` is a sentence for the
 *          operator when `ok` is false, and null otherwise.
 */
export async function preflight({
  filled = [], profile, job = null, channel = '', ats = null, countryCode = 'ZA',
  subject = null, body = null,
} = {}, { callFn = callClaude, enabled = preflightEnabled, hasKeyFn = hasAnthropicKey } = {}) {
  const allow = { ok: true, blocked: [], notes: [], reason: null };
  if (!enabled()) return allow;
  if (!profile) return allow;

  const found = deterministicObjections({ filled, profile, ats, countryCode });

  if (hasKeyFn()) {
    try {
      found.push(...await modelObjections({ filled, profile, job, subject, body }, callFn));
    } catch (err) {
      // The reviewer being unreachable is not evidence that the application is
      // wrong. Say so out loud and go on with what the deterministic half found.
      emit({
        jobId: job?.id, stage: 'apply', level: 'warn',
        message: `Pre-send review could not run (${err.message.split('\n')[0]}) — deterministic checks only`,
      });
    }
  }

  const blocked = found.filter(o => o.severity === 'block');
  const notes = found.filter(o => o.severity !== 'block');

  for (const n of notes) {
    emit({
      jobId: job?.id, stage: 'apply', level: 'debug',
      message: `  pre-send note: ${String(n.question).slice(0, 50)} = ${JSON.stringify(String(n.value).slice(0, 40))} — ${n.why}`,
    });
  }

  if (!blocked.length) return { ok: true, blocked: [], notes, reason: null };

  const first = blocked[0];
  const more = blocked.length > 1 ? ` (and ${blocked.length - 1} more)` : '';
  return {
    ok: false, blocked, notes,
    reason: `held by the pre-send check${more}: "${String(first.question).slice(0, 60)}" was going to be `
      + `sent as ${JSON.stringify(String(first.value).slice(0, 60))} — ${first.why}`,
  };
}

/**
 * The wizard's `mayFinish` shape: a reason to hold, or null to allow.
 *
 * `also` chains an adapter's own check in front of this one, so a caller keeps
 * whatever it already refused to send and gains the review as well.
 */
export function preflightGate({ profile, job, channel, ats, countryCode = 'ZA', also = null }, deps = {}) {
  return async ({ filled, steps }) => {
    if (also) {
      const held = await also({ filled, steps });
      if (held) return held;
    }
    const check = await preflight({ filled, profile, job, channel, ats, countryCode }, deps);
    return check.ok ? null : check.reason;
  };
}
