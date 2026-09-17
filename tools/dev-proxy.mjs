#!/usr/bin/env node
/**
 * Local development server: serves this directory as static files AND proxies
 * POST /v1/systemone to TypeSafe, adding the CORS headers the browser needs.
 *
 * This lets you run the whole thing with no deploy step:
 *
 *     node tools/dev-proxy.mjs
 *     open http://localhost:8787
 *
 * Then put  http://localhost:8787  in the app's "Proxy URL" field.
 * Zero dependencies. The API key is never logged and never stored.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = 'https://api.typesafe.ai';
const UPSTREAM_PATH = '/v1/systemone';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
  'Access-Control-Max-Age': '600',
};

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 5_000_000) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url.pathname === UPSTREAM_PATH) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    const auth = req.headers.authorization;
    if (!auth) return json(res, 401, { error: 'Missing Authorization header.' });

    try {
      const body = await readBody(req);
      // Authorization is forwarded but never printed.
      const upstream = await fetch(`${UPSTREAM}${UPSTREAM_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body,
      });
      const text = await upstream.text();
      const headers = { ...CORS, 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' };
      const rid = upstream.headers.get('x-typesafe-request-id');
      if (rid) headers['x-typesafe-request-id'] = rid;
      res.writeHead(upstream.status, headers);
      res.end(text);
      console.log(`  proxied  ${upstream.status}  ${auth.slice(0, 10)}…  ${text.length}B`);
    } catch (err) {
      console.error('  proxy error:', err.message);
      json(res, 502, { error: `Proxy could not reach TypeSafe: ${err.message}` });
    }
    return;
  }

  // static files
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));

  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  CartPole x Jev  —  dev server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  proxy: POST http://localhost:${PORT}${UPSTREAM_PATH} -> ${UPSTREAM}${UPSTREAM_PATH}`);
  console.log(`  put  http://localhost:${PORT}  in the app's "Proxy URL" field\n`);
});
