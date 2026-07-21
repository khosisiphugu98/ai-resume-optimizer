// Own OpenAI key, used directly. Deliberately NOT the CF Worker proxy: that has a
// 64 KB body cap and a shared key, and this makes 10-20 calls per application.
const API = 'https://api.openai.com/v1/chat/completions';

export const MODEL = 'gpt-4o-mini';

export function hasKey() {
  return !!process.env.OPENAI_API_KEY;
}

export async function callLLM(messages, { json = true, temperature = 0, maxTokens = 900, model = MODEL } = {}) {
  if (!hasKey()) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim();
  return json ? JSON.parse(content) : content;
}
