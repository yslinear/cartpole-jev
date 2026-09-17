/**
 * TypeSafe API client.
 *
 * IMPORTANT: api.typesafe.ai rejects *every* browser origin on preflight
 * (verified against console.typesafe.ai, localhost, null and *.github.io), so a
 * page served from GitHub Pages cannot call it directly. Requests must go
 * through a small pass-through proxy that adds the CORS headers, which is what
 * `worker/` in this repo is for. The proxy is stateless and does not log the key.
 */

export const DIRECT_API = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-latest';

/** A BrowserBlockedError means the request never reached TypeSafe. */
export class BrowserBlockedError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BrowserBlockedError';
    this.cause = cause;
  }
}

export class ApiError extends Error {
  constructor(status, payload, requestId) {
    const detail = Array.isArray(payload?.detail)
      ? payload.detail.map((d) => `${(d.loc ?? []).join('.')}: ${d.msg}`).join('; ')
      : payload?.detail || payload?.message || `HTTP ${status}`;
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.requestId = requestId;
  }
}

/**
 * Ask a batch of questions about one state.
 *
 * @returns {{answers: object, usage: {input_tokens:number, output_tokens:number},
 *            model: string, latencyMs: number, requestId: string|null}}
 */
export async function askJev({ baseUrl, apiKey, state, questions, model = DEFAULT_MODEL, signal }) {
  if (!apiKey) throw new Error('No API key set.');

  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('No proxy URL set.');

  const started = performance.now();
  let res;
  try {
    res = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ state, model, questions }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // fetch() only rejects like this for network-level failures, which in a
    // browser is almost always CORS or an unreachable host.
    throw new BrowserBlockedError(
      `Request to ${base} failed before a response arrived. ` +
        `If you pointed straight at api.typesafe.ai, the browser blocked it: TypeSafe ` +
        `does not send CORS headers for web origins. Use a proxy URL instead. ` +
        `(Original error: ${err?.message ?? err})`,
      err,
    );
  }

  const latencyMs = Math.round(performance.now() - started);
  const requestId = res.headers.get('x-typesafe-request-id');

  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, payload, requestId);
  }

  const data = await res.json();
  return {
    answers: data.answers ?? {},
    usage: data.usage ?? {},
    model: data.model ?? model,
    latencyMs,
    requestId,
  };
}

/** Cheap liveness probe used by the "Test connection" button. */
export async function testConnection({ baseUrl, apiKey, model = DEFAULT_MODEL }) {
  const out = await askJev({
    baseUrl,
    apiKey,
    model,
    state: 'Connection test.',
    questions: { ok: { type: 'noul', instructions: 'Is this a successful connection test?' } },
  });
  return out;
}
