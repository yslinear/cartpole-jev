/**
 * TypeSafe API client.
 *
 * The endpoint is whatever src/config.js says, defaulting to a same-origin
 * relative path. See that file for why pointing at api.typesafe.ai directly is
 * not an option from a browser.
 */

import { API_BASE } from './config.js';

export const DEFAULT_MODEL = 'jev-latest';

export const usingSameOrigin = () => API_BASE === '';

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
export async function askJev({ apiKey, state, questions, model = DEFAULT_MODEL, signal, baseUrl }) {
  if (!apiKey) throw new Error('No API key set.');

  // `baseUrl` is an escape hatch for the Node test harnesses, which talk to a
  // local proxy instead of the origin that served the page. The browser never
  // passes it, so end users only ever supply a key.
  const root = (baseUrl ?? API_BASE).replace(/\/+$/, '');
  const url = `${root}/v1/systemone`;
  const started = performance.now();
  let res;
  try {
    res = await fetch(url, {
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
    // fetch() rejects like this only for network-level failures, which in a
    // browser means CORS or an unreachable host.
    throw new BrowserBlockedError(
      usingSameOrigin() && !baseUrl
        ? `Could not reach ${url}. This page is not being served with an API route, so ` +
          `the browser blocked or failed the request. Run \`node tools/dev-proxy.mjs\` and ` +
          `open http://localhost:8787 instead of opening the file directly. ` +
          `If you are hosting this on a static site, set API_BASE in src/config.js. ` +
          `(Original error: ${err?.message ?? err})`
        : `Could not reach ${url}. The proxy did not answer. Check that it is deployed ` +
          `and that API_BASE in src/config.js is correct. ` +
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
export async function testConnection({ apiKey, model = DEFAULT_MODEL }) {
  return askJev({
    apiKey,
    model,
    state: 'Connection test.',
    questions: { ok: { type: 'noul', instructions: 'Is this a successful connection test?' } },
  });
}
