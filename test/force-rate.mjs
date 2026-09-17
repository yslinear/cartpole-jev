#!/usr/bin/env node
/**
 * Which combination of push force and decision rate actually balances?
 *
 * Jev's decisions agree with a hand-written PD controller ~92% of the time, so
 * the twitching is not bad judgement. The suspect is the hold time: at 10
 * decisions/sec each push is held for 100 ms, and test/interval-limit.mjs showed
 * that even a PERFECT controller collapses when forced to hold that long. A
 * gentler force makes the same 100 ms of held push do less damage.
 *
 * This sweeps force against decision rate with real API calls and reports the
 * score, so the answer is measured rather than guessed.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/force-rate.mjs --episodes 1
 */

import { stepForce, resetState, MAX_STEPS, TAU, FORCE_MAG } from '../public/src/cartpole.js';
import { buildState } from '../public/src/state.js';
import { QUESTIONS, POLICIES } from '../public/src/questions.js';
import { askJev, DEFAULT_MODEL } from '../public/src/typesafe.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('episodes', 1));
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const PRICE = 0.042 / 1e6;

/** @param force newtons  @param every physics steps held per decision */
async function play(force, every) {
  let state = resetState();
  let action = 1;
  let score = 0;
  let tokens = 0;
  let decisions = 0;
  let flips = 0;
  let prev = action;
  let maxAbsAngle = 0;
  let ended = 'cap';

  outer: while (true) {
    if (score % every === 0) {
      const out = await askJev({
        baseUrl: PROXY, apiKey: KEY, model: DEFAULT_MODEL,
        state: buildState({ ...state }, 'prose'),
        questions: QUESTIONS,
      });
      tokens += out.usage.input_tokens ?? 0;
      decisions++;
      const next = POLICIES.threshold.decide(out.answers, action).action;
      if (next !== prev && decisions > 1) flips++;
      prev = next;
      action = next;
    }
    for (let k = 0; k < every; k++) {
      const r = stepForce(state, force * (action === 1 ? 1 : -1));
      state = r.state;
      score += r.reward;
      maxAbsAngle = Math.max(maxAbsAngle, Math.abs(state.theta) * 180 / Math.PI);
      if (r.terminated) { ended = 'fell'; break outer; }
      if (score >= MAX_STEPS) { ended = 'cap'; break outer; }
    }
  }
  return { score, tokens, decisions, flips, maxAbsAngle, ended };
}

const combos = [
  { force: FORCE_MAG, every: 5, label: '10 N, 10/sec  (current default)' },
  { force: FORCE_MAG, every: 2, label: '10 N, 25/sec' },
  { force: FORCE_MAG, every: 1, label: '10 N, 50/sec (every step)' },
  { force: 6, every: 5, label: ' 6 N, 10/sec' },
  { force: 6, every: 2, label: ' 6 N, 25/sec' },
  { force: 4, every: 5, label: ' 4 N, 10/sec' },
  { force: 4, every: 2, label: ' 4 N, 25/sec' },
  { force: 3, every: 1, label: ' 3 N, 50/sec' },
];

console.log(`\n  ${RUNS} episode(s) per row. 500 = balanced perfectly.\n`);
const rows = [];
for (const c of combos) {
  const out = [];
  for (let i = 0; i < RUNS; i++) out.push(await play(c.force, c.every));
  const mean = (f) => out.reduce((a, r) => a + f(r), 0) / out.length;
  const row = {
    label: c.label,
    score: mean((r) => r.score),
    best: Math.max(...out.map((r) => r.score)),
    flips: mean((r) => r.flips),
    decisions: mean((r) => r.decisions),
    tokens: mean((r) => r.tokens),
    angle: mean((r) => r.maxAbsAngle),
    caps: out.filter((r) => r.ended === 'cap').length,
  };
  rows.push(row);
  process.stdout.write(`  ${c.label}  → ${row.score.toFixed(0)} ${row.caps ? '(balanced!)' : ''}\n`);
}

console.log('\n  ' + '-'.repeat(96));
console.log(`  ${'setup'.padEnd(34)} ${'score'.padStart(6)} ${'best'.padStart(5)} ${'flips'.padStart(6)} ${'decisions'.padStart(10)} ${'tok/ep'.padStart(8)}  ${'peak |angle|'.padStart(12)}`);
console.log('  ' + '-'.repeat(96));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(34)} ${r.score.toFixed(0).padStart(6)} ${String(r.best).padStart(5)} ` +
      `${r.flips.toFixed(0).padStart(6)} ${r.decisions.toFixed(0).padStart(10)} ${r.tokens.toFixed(0).padStart(8)}  ` +
      `${r.angle.toFixed(1).padStart(11)}°`,
  );
}
console.log('  ' + '-'.repeat(96));
console.log(
  '\n  If the low-force rows balance and the 10 N row does not, the problem was\n' +
    '  never Jev\'s judgement -- it was how much damage one held push does.\n',
);
