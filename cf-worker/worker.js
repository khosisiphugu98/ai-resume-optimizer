// Allowlist of models the proxy may forward. Prevents abuse with expensive models.
const ALLOWED_MODELS = new Set([
  'gpt-4o-mini',
  'gpt-4o',
]);

// 64 KB cap on forwarded bodies — prevents large-payload abuse.
const MAX_BODY_BYTES = 65_536;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/v1/chat/completions') {
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }

    // Shared-secret check — the client sends this header; anyone without it is rejected.
    // The secret is in the client JS (so anyone who reads source can find it), but it
    // stops automated scanners, bots, and casual URL-guessing from burning the API key.
    // Rotate both this value and PROXY_TOKEN in wrangler.toml together if abused.
    const token = request.headers.get('X-Proxy-Token');
    if (!env.PROXY_TOKEN || token !== env.PROXY_TOKEN) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
    }

    // Enforce body size limit before reading the full payload.
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return new Response('Request too large', { status: 413, headers: corsHeaders() });
    }

    let body;
    let parsedBody;
    try {
      body = await request.text();
      if (body.length > MAX_BODY_BYTES) {
        return new Response('Request too large', { status: 413, headers: corsHeaders() });
      }
      parsedBody = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON body', { status: 400, headers: corsHeaders() });
    }

    // Enforce model allowlist — prevents callers from requesting expensive models.
    if (!ALLOWED_MODELS.has(parsedBody.model)) {
      return new Response(
        JSON.stringify({ error: { message: `Model '${parsedBody.model}' is not permitted by this proxy.` } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body,
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    // Wildcard is required: this app may run from a file:// origin which browsers
    // report as a null origin, so a specific-origin allowlist can't be used.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
  };
}
