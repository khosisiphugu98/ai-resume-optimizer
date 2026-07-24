// Anthropic Messages API, hand-rolled the same way llm.js hand-rolls OpenAI —
// the project ships no SDK, and the planner is the only caller, so a raw fetch
// keeps the dependency surface flat. Used for the adaptive agent's whole-page
// planner (docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md); field-answer resolution
// stays on OpenAI via llm.js.
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// The most capable Opus-tier model — whole-page planning is intelligence-
// sensitive, and a wrong plan wastes a page. Callers may override.
export const CLAUDE_MODEL = 'claude-opus-4-8';

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
export async function callClaude(messages, { system, schema, model = CLAUDE_MODEL, maxTokens = 2000 } = {}) {
  if (!hasAnthropicKey()) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
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
  if (data.stop_reason === 'refusal') throw new Error('Claude refused the request');

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
