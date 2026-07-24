// The whole-page planner. Given an observation (observe.js), it returns a
// structured plan the executor can run, or null if no model could produce a
// usable one.
//
// Provider-abstracted on purpose: the primary is Claude opus (structured
// outputs, so the plan is guaranteed to validate), and the fallback is OpenAI
// gpt-4o through the existing llm.js path. Anything that fails on the Claude
// side — no key, an HTTP error, or a plan that fails our own sanity check —
// falls through to OpenAI on one code path. Both callers are injectable so the
// planner is testable with no network. See docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md.
import { callClaude, hasAnthropicKey } from '../../llm-anthropic.js';
import { callLLM, hasKey as hasOpenAIKey } from '../../llm.js';
import { emit } from '../../bus.js';

const OPENAI_PLANNER_MODEL = 'gpt-4o';

// Stable locator strategies only — the same discipline the vendor configs use.
// A hashed class (._7e3b9f11) changes every deploy, so it is never allowed.
export const LOCATOR_STRATEGIES = ['label', 'role', 'name', 'placeholder', 'text'];
export const FIELD_TYPES = [
  'text', 'email', 'tel', 'url', 'number', 'textarea',
  'select', 'radio', 'checkbox', 'file', 'date', 'password',
];

// JSON Schema for Claude's structured output. Kept to types/enums that structured
// outputs support (no minLength/pattern). additionalProperties:false throughout.
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'preSteps', 'fields', 'advance', 'submit'],
  properties: {
    kind: { type: 'string', enum: ['form', 'landing', 'unsupported'] },
    preSteps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['action', 'target'],
        properties: { action: { type: 'string', enum: ['click'] }, target: { type: 'string' } },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'type', 'required', 'locator'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string', enum: FIELD_TYPES },
          required: { type: 'boolean' },
          locator: {
            type: 'object', additionalProperties: false, required: ['by', 'value'],
            properties: { by: { type: 'string', enum: LOCATOR_STRATEGIES }, value: { type: 'string' } },
          },
        },
      },
    },
    advance: {
      type: ['object', 'null'], additionalProperties: false, required: ['by', 'value'],
      properties: { by: { type: 'string', enum: ['role', 'text'] }, value: { type: 'string' } },
    },
    submit: {
      type: ['object', 'null'], additionalProperties: false, required: ['by', 'value'],
      properties: { by: { type: 'string', enum: ['role', 'text'] }, value: { type: 'string' } },
    },
  },
};

// A value that looks like a CSS selector or a hashed token is not a stable
// accessible name — reject it so the plan can never depend on a hashed class.
const looksLikeSelector = v =>
  /^[.#\[]/.test(v) || /_[0-9a-f]{6,}\b/i.test(v) || /[.#>]{1}[\w-]{2,}/.test(v);

/** Structural sanity check beyond the schema. Returns { ok, reason }. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'not an object' };
  if (!['form', 'landing', 'unsupported'].includes(plan.kind)) return { ok: false, reason: `bad kind "${plan.kind}"` };
  if (plan.kind === 'unsupported') return { ok: true };          // a valid "give up" verdict

  if (!Array.isArray(plan.fields)) return { ok: false, reason: 'fields is not an array' };
  for (const f of plan.fields) {
    if (!f?.label) return { ok: false, reason: 'a field has no label' };
    if (!FIELD_TYPES.includes(f.type)) return { ok: false, reason: `bad field type "${f.type}"` };
    if (!f.locator || !LOCATOR_STRATEGIES.includes(f.locator.by)) return { ok: false, reason: `bad locator.by on "${f.label}"` };
    if (!f.locator.value) return { ok: false, reason: `empty locator on "${f.label}"` };
    if (looksLikeSelector(f.locator.value)) return { ok: false, reason: `locator "${f.locator.value}" looks like a hashed selector` };
  }
  // A "form" plan with nothing to fill is not a plan.
  if (plan.kind === 'form' && !plan.fields.length && !(plan.preSteps || []).length) {
    return { ok: false, reason: 'form plan has no fields and no preSteps' };
  }
  return { ok: true };
}

const SYSTEM = `You map an unknown job-application web page to a structured fill plan.
Rules:
- Return ONLY controls a candidate must fill to apply. Ignore search boxes, cookie banners, marketing.
- Locators must be STABLE: an accessible name/label, an ARIA role name, a name= or placeholder attribute, or exact visible text. NEVER a CSS class or hashed token.
- If the form is hidden behind an "Apply"/"Start" button, set kind:"landing" and put that click in preSteps.
- If the page has no reachable application form at all, return kind:"unsupported" with empty fields.
- advance = the control that moves to the next step (Next/Continue) or null. submit = the final submit control or null. You are NOT submitting; submit only names the terminal control.`;

function userPrompt(observation) {
  return `Page observation (JSON):\n${JSON.stringify({
    host: observation.host,
    title: observation.title,
    traps: observation.traps,
    buttons: observation.buttons,
    controls: observation.controls,
    frames: observation.frames,
    outline: observation.outline,
  }, null, 2)}\n\nReturn a plan object matching this shape:\n${JSON.stringify(PLAN_SCHEMA.properties, null, 0)}`;
}

/**
 * Produce a validated plan, or null if no provider could.
 *
 * @param observation  observePage() output
 * @param deps         { callClaudeFn, callOpenAIFn } — injectable for tests
 */
export async function planPage(observation, { callClaudeFn = callClaude, callOpenAIFn = callLLM } = {}) {
  const messages = [{ role: 'user', content: userPrompt(observation) }];

  // Primary: Claude, with the schema enforced server-side.
  if (hasAnthropicKey()) {
    try {
      const plan = await callClaudeFn(messages, { system: SYSTEM, schema: PLAN_SCHEMA });
      const check = validatePlan(plan);
      if (check.ok) { emit({ stage: 'apply', message: `Agent plan from Claude (${plan.kind}, ${plan.fields?.length || 0} field(s))` }); return plan; }
      emit({ stage: 'apply', level: 'warn', message: `Claude plan rejected — ${check.reason}; falling back to gpt-4o` });
    } catch (err) {
      emit({ stage: 'apply', level: 'warn', message: `Claude planner failed (${err.message.split('\n')[0]}) — falling back to gpt-4o` });
    }
  }

  // Fallback: OpenAI gpt-4o via the existing JSON path.
  if (hasOpenAIKey()) {
    try {
      const plan = await callOpenAIFn(
        [{ role: 'system', content: SYSTEM }, ...messages],
        { json: true, model: OPENAI_PLANNER_MODEL, maxTokens: 2000 },
      );
      const check = validatePlan(plan);
      if (check.ok) { emit({ stage: 'apply', message: `Agent plan from gpt-4o (${plan.kind}, ${plan.fields?.length || 0} field(s))` }); return plan; }
      emit({ stage: 'apply', level: 'warn', message: `gpt-4o plan rejected — ${check.reason}` });
    } catch (err) {
      emit({ stage: 'apply', level: 'warn', message: `gpt-4o planner failed — ${err.message.split('\n')[0]}` });
    }
  }

  return null;
}
