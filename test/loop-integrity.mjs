#!/usr/bin/env node
/**
 * Regression test for runaway episodes.
 *
 * The bug this exists for: a terminated CartPole state keeps reporting
 * terminated, so unless the loop stops, every further physics step calls
 * endEpisode() again. That produced, in the wild:
 *
 *     episode 292 ended after 12 steps
 *     episode 293 ended after 13 steps      <- score climbing in lockstep
 *     episode 294 ended after 14 steps
 *     ...
 *     episode 292 started                   <- repeated, one per queued timer
 *
 * It looked like the model falling over instantly, and no existing test caught
 * it: test/smoke-dom.mjs never starts the loop (no API key), and the headless
 * harnesses exit with `break outer` so they never step past termination.
 *
 * This runs the real app.js against a stub DOM and a stub fetch, presses Start,
 * and watches what the loop actually does for a few seconds.
 *
 * Run:  node test/loop-integrity.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);

/* --------------------------------------------------------------- fake DOM -- */

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

/**
 * Record every fillText so the HUD can be checked for collisions.
 *
 * Two lines drawn at the same y overlap and become unreadable, and nothing about
 * the code makes that obvious -- it happened once when "synced to ..." was put at
 * y=84 while the Jev line was already at y=88. Any future line inserted with a
 * hard-coded y will trip this.
 */
const textCalls = [];
function recordingContext() {
  return anyObj({
    // clearRect starts a frame, so reset here: only the latest frame's HUD is
    // on screen. Accumulating across frames made every line look like a
    // collision with its own previous value.
    clearRect() { textCalls.length = 0; },
    fillText(text, x, y) { textCalls.push({ text: String(text), x, y }); },
    measureText: () => ({ width: 100 }),
  });
}

function makeEl(id) {
  return anyObj({
    id, value: '', textContent: '', innerHTML: '', checked: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); return k; },
    addEventListener() {}, removeEventListener() {}, remove() {},
    setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 420, right: 900, bottom: 420 }),
    getContext: () => recordingContext(),
    focus() {}, firstElementChild: null, scrollTop: 0, scrollHeight: 0,
  });
}
for (const id of ids) elements.set(id, makeEl(id));

let rafCount = 0;
const startTime = Date.now();

globalThis.window = anyObj({
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
});
globalThis.document = anyObj({
  getElementById: (id) => elements.get(id) ?? makeEl(id),
  createElement: () => makeEl('created'),
  addEventListener() {},
  documentElement: anyObj({ classList: { add() {}, remove() {} } }),
});
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
globalThis.requestAnimationFrame = (fn) => {
  rafCount++;
  // drive `now` from the wall clock so setTimeout and rAF agree
  setTimeout(() => fn(Date.now() - startTime), 16);
  return rafCount;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
globalThis.devicePixelRatio = 2;

/* ------------------------------------------------------------- stub the API -- */

let apiCalls = 0;
globalThis.fetch = async () => {
  apiCalls++;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'x-typesafe-request-id' ? 'req_test' : null) },
    json: async () => ({
      model: 'jev-stub',
      answers: {
        // always shove right: guarantees the pole falls quickly, which is what
        // we want in order to exercise the termination path hard
        push_right: { type: 'noul', noul: 0.99 },
        direction: { type: 'choice', choice: 'push_right', confidence: 0.95 },
        falling_right: { type: 'noul', noul: 0.9 },
        instability: { type: 'score', score: 2.5, confidence: 0.6 },
      },
      usage: { input_tokens: 700, output_tokens: 12 },
    }),
  };
};

/* -------------------------------------------------------------------- run -- */

const failures = [];
process.on('uncaughtException', (e) => failures.push(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => failures.push(`unhandled rejection: ${e?.message ?? e}`));

await import(pathToFileURL(new URL('public/src/app.js', ROOT).pathname).href);

// give it an "API key" and press Start, exactly like a user
elements.get('apiKey').value = 'ts_stub_key';
elements.get('btnStart').onclick();

const RUN_MS = 4000;
await new Promise((r) => setTimeout(r, RUN_MS));
// Let one more render land: renderStats is throttled to 120 ms, so reading
// immediately after an episode ends can see the previous episode count and look
// like the stats disagree with the log when they are merely one frame behind.
await new Promise((r) => setTimeout(r, 250));

/* ----------------------------------------------------------------- verdict -- */

const logEl = elements.get('log');
const entries = logEl.children ?? [];
const textOf = (e) => (e.children?.[1]?.innerHTML ?? '');

const started = entries.filter((e) => textOf(e).includes('episode') && textOf(e).includes('started'));
const ended = entries.filter((e) => textOf(e).includes('ended'));

// extract the episode numbers to catch the "same N started twice" symptom
const startedNums = started.map((e) => (textOf(e).match(/episode (\d+) started/) ?? [])[1]).filter(Boolean);
const dupStart = startedNums.filter((n, i) => startedNums.indexOf(n) !== i);

const statsHtml = elements.get('stats').innerHTML ?? '';
const statsEpisodes = Number((statsHtml.match(/Episodes<\/dt><dd>(\d+)<\/dd>/) ?? [])[1] ?? NaN);

// HUD collision check on the last frame only: left-aligned lines in the same
// column must not share a y. Two different strings at one y cannot both be read.
const frameText = textCalls.slice();
const hudLines = frameText.filter((c) => c.x === 14).map((c) => ({ y: c.y, text: c.text }));
const byY = new Map();
for (const l of hudLines) {
  if (!byY.has(l.y)) byY.set(l.y, []);
  byY.get(l.y).push(l.text);
}
const collisions = [...byY.entries()].filter(([, texts]) => new Set(texts).size > 1);

console.log(`\n  ran for .................... ${RUN_MS} ms`);
console.log(`  animation frames ........... ${rafCount}`);
console.log(`  stubbed API calls .......... ${apiCalls}`);
console.log(`  "episode N started" lines ... ${started.length}`);
console.log(`  "ended" lines ............... ${ended.length}`);
console.log(`  episode number in stats ..... ${statsEpisodes}`);
console.log(`  duplicate "started" numbers . ${dupStart.length}`);
console.log(`  HUD lines on the last frame .. ${byY.size} rows`);

// A runaway produces endEpisode() calls every frame. At ~60 fps over 4 s that
// is ~240 of them; a healthy loop produces a handful of real episodes.
const FRAME_BUDGET = rafCount * 0.25;

if (dupStart.length) {
  failures.push(`${dupStart.length} duplicate "episode N started" lines: ${[...new Set(dupStart)].slice(0, 5).join(', ')} — several restart timers were queued`);
}
if (ended.length > FRAME_BUDGET) {
  failures.push(`${ended.length} episodes ended, which is more than a quarter of the ${rafCount} frames — endEpisode is being called per frame, so the loop is not stopping`);
}
if (started.length > ended.length + 1) {
  failures.push(`${started.length} episodes started but only ${ended.length} ended — restarts are outrunning real episodes`);
}
// One episode may legitimately still be in flight when we stop looking, and the
// stats block lags the log by up to one throttled render.
const statsLag = started.length - ended.length;
if (Number.isFinite(statsEpisodes) && Math.abs(statsEpisodes - ended.length) > 1) {
  failures.push(`stats say ${statsEpisodes} episodes but the log shows ${ended.length} — they disagree by more than the one-episode lag a live loop allows`);
}
if (statsLag < 0 || statsLag > 1) {
  failures.push(`${started.length} episodes started but ${ended.length} ended — the counts should differ by at most one (the episode still running)`);
}
if (apiCalls === 0) {
  failures.push('the loop never called the API, so this test proved nothing');
}
for (const [y, texts] of collisions) {
  failures.push(`HUD lines overlap at y=${y}: ${texts.map((t) => JSON.stringify(t.slice(0, 34))).join(' and ')}`);
}

if (failures.length) {
  console.error('\n  FAIL');
  for (const f of failures) console.error(`    ${f}`);
  console.error('');
  process.exit(1);
}

console.log('\n  ✅ one start per episode, one end per episode, none per frame');
console.log('  ✅ no HUD lines share a y coordinate\n');
process.exit(0);
