/**
 * TypeSafe CORS pass-through proxy (Cloudflare Worker).
 *
 * Why this exists: api.typesafe.ai answers preflight with
 * `400 Disallowed CORS origin` for every web origin, so a static page cannot
 * call it from the browser. This Worker forwards the request server-side and
 * attaches the CORS headers the browser needs.
 *
 * Security properties:
 *   - stateless: nothing is written to storage
 *   - the Authorization header is forwarded verbatim and NEVER logged
 *   - only POST /v1/systemone is proxied; the upstream host is hard-coded, so
 *     this cannot be used as a general-purpose open relay
 *   - optional shared secret via the PROXY_TOKEN env var
 *   - optional origin allowlist via the ALLOWED_ORIGINS env var
 *
 * The API key still transits this Worker. Every user supplies their own key and
 * it is only ever sent to api.typesafe.ai, but an operator of a public instance
 * can in principle observe it. Self-host if that matters to you.
 */

const UPSTREAM = 'https://api.typesafe.ai';
const UPSTREAM_PATH = '/v1/systemone';

function allowOrigin(request, env) {
  const configured = (env?.ALLOWED_ORIGINS ?? '').trim();
  const origin = request.headers.get('Origin') ?? '';

  if (!configured || configured === '*') return '*';

  const list = configured.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  return null; // not allowed
}

function corsHeaders(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    ...extra,
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowOrigin(request, env);

    if (origin === null) {
      return json({ error: 'Origin not allowed by this proxy.' }, 403, { Vary: 'Origin' });
    }

    const cors = corsHeaders(origin);

    // preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // tiny health/liveness surface so the URL can be opened in a browser
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, proxying: `${UPSTREAM}${UPSTREAM_PATH}` }, 200, cors);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed. Use POST /v1/systemone.' }, 405, cors);
    }

    if (url.pathname !== UPSTREAM_PATH) {
      return json({ error: `Not found. This proxy only serves POST ${UPSTREAM_PATH}.` }, 404, cors);
    }

    // optional shared secret
    const requiredToken = (env?.PROXY_TOKEN ?? '').trim();
    if (requiredToken && request.headers.get('X-Proxy-Token') !== requiredToken) {
      return json({ error: 'Missing or invalid X-Proxy-Token.' }, 401, cors);
    }

    const auth = request.headers.get('Authorization');
    if (!auth) {
      return json({ error: 'Missing Authorization header.' }, 401, cors);
    }

    // No logging of headers here on purpose: Authorization carries the user's key.
    const upstream = await fetch(`${UPSTREAM}${UPSTREAM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: request.body,
    });

    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    const requestId = upstream.headers.get('x-typesafe-request-id');
    if (requestId) headers.set('x-typesafe-request-id', requestId);

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
