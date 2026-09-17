#!/usr/bin/env node
/**
 * Init-time smoke test for src/app.js.
 *
 * The id check in the README catches ids that the HTML no longer defines, but it
 * cannot catch a runtime error on the way through wire() or one pass of frame().
 * This builds just enough of a DOM to import the real module, run its bottom-of-
 * file init, and execute a couple of animation frames.
 *
 * No API calls are made: there is no key configured, so the loop never decides.
 *
 * Run:  node test/smoke-dom.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);

/* --------------------------------------------------------------- fake DOM -- */

/** Any property access returns a no-op function; assignment is allowed. */
function anyObj(extra = {}) {
  const store = { ...extra };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === Symbol.toPrimitive) return () => '';
      return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
    has() { return true; },
  });
}

const html = readFileSync(new URL('public/index.html', ROOT), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

const elements = new Map();
function makeEl(id) {
  const el = anyObj({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); return k; },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 420, right: 900, bottom: 420 }),
    getContext: () => anyObj(),
    focus() {},
    firstElementChild: null,
    scrollTop: 0,
    scrollHeight: 0,
  });
  return el;
}

for (const id of ids) elements.set(id, makeEl(id));

const listeners = { window: 0, document: 0 };
let rafCount = 0;

globalThis.window = anyObj({
  addEventListener(type) { listeners.window++; void type; },
  removeEventListener() {},
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
});
globalThis.document = anyObj({
  getElementById: (id) => elements.get(id) ?? makeEl(id),
  createElement: () => makeEl('created'),
  addEventListener(type) { listeners.document++; void type; },
  documentElement: anyObj({ classList: { add() {}, remove() {} } }),
});
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.requestAnimationFrame = (fn) => {
  rafCount++;
  // run a couple of frames, then stop so the process can exit
  if (rafCount <= 3) queueMicrotask(() => fn(rafCount * 16.7));
  return rafCount;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
globalThis.devicePixelRatio = 2;

/* -------------------------------------------------------------------- run -- */

const failures = [];
process.on('uncaughtException', (e) => { failures.push(`uncaught: ${e.message}`); });
process.on('unhandledRejection', (e) => { failures.push(`unhandled rejection: ${e?.message ?? e}`); });

try {
  await import(pathToFileURL(new URL('public/src/app.js', ROOT).pathname).href);
} catch (e) {
  failures.push(`import threw: ${e.message}`);
}

// give the queued frames a chance to run
await new Promise((r) => setTimeout(r, 120));

console.log(`\n  ids stubbed .............. ${ids.length}`);
console.log(`  window/document listeners  ${listeners.window} / ${listeners.document}`);
console.log(`  animation frames run ..... ${rafCount}`);

if (failures.length) {
  console.error('\n  FAIL');
  for (const f of failures) console.error(`    ${f}`);
  console.error('');
  process.exit(1);
}

console.log('\n  ✅ app.js imported, wired up and rendered without throwing\n');
