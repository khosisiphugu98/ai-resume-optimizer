// Anthropic Messages API, hand-rolled the same way llm.js hand-rolls OpenAI —
// the project ships no SDK, and the planner is the only caller, so a raw fetch
// keeps the dependency surface flat. Used for the adaptive agent's whole-page
// planner (docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md); field-answer resolution
// stays on OpenAI via llm.js.
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// Whole-page planning is intelligence-sensitive and a wrong plan wastes a page,
// so this stays on the current Opus. Callers may override.
export const CLAUDE_MODEL = 'claude-opus-5';

/**
 * Output ceiling for one plan.
 *
 * `max_tokens` caps thinking AND response text together, and thinking is on by
 * default on this model — so the old 2000 was a truncation trap: high-effort
 * reasoning over a full page observation would consume most of it, the JSON
 * would arrive cut in half, and `JSON.parse` would throw a syntax error that
 * read like the model had misbehaved. A plan is small; the headroom is for the
 * thinking in front of it.
 */
const MAX_PLAN_TOKENS = 16000;

export function hasAnthropicKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * One structured-output call. `schema` (JSON Schema) is enforced by the API via
 * output_config.format, so the returned object is guaranteed to validate — no
 * brittle JSON-from-prose parsing. Adaptive thinking is left on at `high` effort
 * because planning benefits from it; the plan itself is small, so no streaming.
 *
 * Throws on a missing key or any non-2xx response, so the planner can fall back
 * to OpenAI on exactly one code path (a thrown error), not two.
 */
export async function callClaude(messages, { system, schema, model = CLAUDE_MODEL, maxTokens = MAX_PLAN_TOKENS } = {}) {
  if (!hasAnthropicKey()) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    // A safety classifier can decline a request outright. Without a fallback the
    // call simply stops; with one the API re-runs it on another model inside the
    // same request, so a decline costs a plan rather than the application.
    fallbacks: 'default',
    messages,
  };
  if (system) body.system = system;
  if (schema) body.output_config.format = { type: 'json_schema', schema };

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': VERSION,
      // Gates the `fallbacks: 'default'` field above. The scalar form and this
      // header are a matched pair — the array form uses a different date, and
      // crossing them is a 400.
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // A safety decline comes back as a 200 with stop_reason "refusal" and no usable
  // content — treat it as a failure so the caller falls back rather than parsing
  // an empty answer.
  // `stop_details` is populated only on a refusal — guard before reading it.
  if (data.stop_reason === 'refusal') {
    const why = data.stop_details?.category ? ` (${data.stop_details.category})` : '';
    throw new Error(`Claude refused the request${why}`);
  }

  // Truncation, said plainly. A response cut off at the token ceiling still
  // arrives as a 200 with partial content, so without this check the half-written
  // JSON reached JSON.parse and surfaced as "Unexpected end of JSON input" —
  // a truncation budget problem wearing a parser error's clothes.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Claude hit the ${maxTokens}-token ceiling before finishing — raise max_tokens`);
  }

  // Content is a list of blocks; the answer is the concatenated text blocks.
  // With a schema, that text is the JSON object the schema constrained.
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Claude returned no text content');

  return schema ? JSON.parse(text) : text;
}
