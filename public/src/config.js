/**
 * The only configuration line in this project.
 *
 * '' means "same origin": the page calls /v1/systemone on whatever host served
 * it. That is correct whenever the page is served by a proxy -- which is what
 * tools/dev-proxy.mjs does, serving the files and the API route from one origin,
 * so same-origin requests never involve CORS at all.
 *
 * Set an absolute URL ONLY if you host the page somewhere that has no backend,
 * such as GitHub Pages:
 *
 *     export const API_BASE = 'https://typesafe-cors-proxy.you.workers.dev';
 *
 * api.typesafe.ai itself cannot be used here: it answers every browser origin
 * with `400 Disallowed CORS origin`, so a static page pointing straight at it
 * gets a network error, not a response.
 */
export const API_BASE = '';
