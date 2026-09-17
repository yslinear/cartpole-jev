/**
 * Cloudflare Pages Function — the API route, on the same origin as the page.
 *
 * Deploy this project to Cloudflare Pages and /v1/systemone just works, with no
 * configuration anywhere: the page posts to its own origin, exactly like it does
 * under tools/dev-proxy.mjs locally. `API_BASE` in src/config.js stays ''.
 *
 * Why this exists at all: api.typesafe.ai answers every browser origin with
 * `400 Disallowed CORS origin`, so a static host (GitHub Pages) can never call
 * it from the browser. A same-origin route like this one sidesteps CORS
 * entirely rather than working around it.
 *
 * Properties: stateless, forwards the Authorization header verbatim, never logs
 * it, and only proxies the one documented upstream path.
 */

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
};

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestPost({ request }) {
  const auth = request.headers.get('Authorization');
  if (!auth) return json({ error: 'Missing Authorization header.' }, 401);

  // Note: no logging of headers. Authorization carries the user's own key.
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: request.body,
      // Required by undici (Node) when streaming a body, ignored by the
      // Cloudflare runtime. Without it the fetch throws, which is how this bug
      // was caught: test the function before trusting it.
      duplex: 'half',
    });
  } catch (err) {
    return json({ error: `Could not reach TypeSafe: ${err.message}` }, 502);
  }

  const headers = new Headers(cors);
  headers.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
  const requestId = upstream.headers.get('x-typesafe-request-id');
  if (requestId) headers.set('x-typesafe-request-id', requestId);

  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Anything that is not a POST gets a readable hint instead of a blank 405. */
export async function onRequestGet() {
  return json({ ok: true, hint: 'POST JSON to this path to reach TypeSafe.' }, 200);
}
