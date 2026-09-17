#!/usr/bin/env node
/**
 * Can Jev decide how hard to push, and does it actually help?
 *
 * The controller has always been bang-bang: pick a direction, push with a fixed
 * force. test/interval-limit.mjs showed why that is fragile — a constant force
 * held across a long decision interval always overshoots, so even a perfect rule
 * collapses past ~5 steps. A proportional controller applies a force that shrinks
 * with the error and does far less damage over the same interval.
 *
 * So: give the model a second question. `push_right` (Noul) supplies the
 * direction, `push_force` (Score) supplies the magnitude, and code multiplies
 * them. Everything else is identical, so any difference is attributable to the
 * force being chosen rather than fixed.
 *
 * Both policies are run at the same decision intervals with real API calls.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/force-grading.mjs --episodes 2
 */

import { stepForce, resetState, MAX_STEPS } from '../public/src/cartpole.js';
import { buildState } from '../public/src/state.js';
import { QUESTIONS, POLICIES } from '../public/src/questions.js';
import { askJev, DEFAULT_MODEL } from '../public/src/typesafe.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('episodes', 2));
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const BASE_FORCE = 4; // newtons, the shipped default

/**
 * @param policy 'threshold' (fixed force) or 'graded' (model picks it)
 * @param every  physics steps each decision is held for
 */
async function play(policy, every) {
  let state = resetState();
  let action = 1;
  let magnitude = BASE_FORCE;
  let score = 0;
  let tokens = 0;
  let peak = 0;
  let ended = 'cap';
  const forcesUsed = [];

  outer: while (true) {
    if (score % every === 0) {
      const out = await askJev({
        baseUrl: PROXY, apiKey: KEY, model: DEFAULT_MODEL,
        state: buildState({ ...state }, 'prose'),
        questions: QUESTIONS,
      });
      tokens += out.usage.input_tokens ?? 0;
      const d = POLICIES[policy].decide(out.answers, action, { baseForceN: BASE_FORCE });
      action = d.action;
      magnitude = d.force ?? BASE_FORCE;
      forcesUsed.push(magnitude);
    }

    for (let k = 0; k < every; k++) {
      const r = stepForce(state, action === 1 ? magnitude : -magnitude);
      state = r.state;
      score += r.reward;
      peak = Math.max(peak, Math.abs(state.theta) * 180 / Math.PI);
      if (r.terminated) { ended = 'fell'; break outer; }
      if (score >= MAX_STEPS) { ended = 'cap'; break outer; }
    }
  }

  const meanForce = forcesUsed.length ? forcesUsed.reduce((a, b) => a + b, 0) / forcesUsed.length : 0;
  const spread = forcesUsed.length
    ? Math.max(...forcesUsed) - Math.min(...forcesUsed)
    : 0;
  return { score, tokens, ended, peak, meanForce, spread, decisions: forcesUsed.length, forcesUsed };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`\n  ${RUNS} episodes per row, base force ${BASE_FORCE} N, real API calls\n`);
const rows = [];
for (const policy of ['threshold', 'graded']) {
  for (const every of [2, 5, 10, 20]) {
    const out = [];
    for (let i = 0; i < RUNS; i++) out.push(await play(policy, every));
    const row = {
      policy,
      every,
      holdMs: every * 20,
      score: mean(out.map((r) => r.score)),
      best: Math.max(...out.map((r) => r.score)),
      caps: out.filter((r) => r.ended === 'cap').length,
      peak: mean(out.map((r) => r.peak)),
      meanForce: mean(out.map((r) => r.meanForce)),
      spread: mean(out.map((r) => r.spread)),
      tokens: Math.round(mean(out.map((r) => r.tokens))),
    };
    rows.push(row);
    process.stdout.write(
      `  ${policy.padEnd(10)} every ${String(every).padStart(2)} steps (${String(row.holdMs).padStart(3)} ms)  → ` +
        `${String(Math.round(row.score)).padStart(3)}  ${row.caps ? '(balanced)' : ''}\n`,
    );
  }
}

console.log('\n  ' + '-'.repeat(104));
console.log(
  `  ${'policy'.padEnd(11)} ${'decision interval'.padEnd(19)} ${'score'.padStart(6)} ${'best'.padStart(5)} ` +
    `${'balanced'.padStart(9)} ${'peak |angle|'.padStart(12)} ${'mean force'.padStart(11)} ${'force range'.padStart(12)} ${'tok/ep'.padStart(8)}`,
);
console.log('  ' + '-'.repeat(104));
for (const r of rows) {
  console.log(
    `  ${r.policy.padEnd(11)} ${`every ${r.every} steps / ${r.holdMs} ms`.padEnd(19)} ${r.score.toFixed(0).padStart(6)} ` +
      `${String(r.best).padStart(5)} ${`${r.caps}/${RUNS}`.padStart(9)} ${(r.peak.toFixed(1) + '°').padStart(12)} ` +
      `${(r.meanForce.toFixed(1) + ' N').padStart(11)} ${(r.spread.toFixed(1) + ' N').padStart(12)} ${String(r.tokens).padStart(8)}`,
  );
}
console.log('  ' + '-'.repeat(104));

const fixedAt10 = rows.find((r) => r.policy === 'threshold' && r.every === 10);
const gradedAt10 = rows.find((r) => r.policy === 'graded' && r.every === 10);
if (fixedAt10 && gradedAt10) {
  const delta = gradedAt10.score - fixedAt10.score;
  console.log(
    `\n  At a 200 ms decision interval, choosing the force is worth ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} score ` +
      `(${fixedAt10.score.toFixed(0)} → ${gradedAt10.score.toFixed(0)}).`,
  );
  console.log(
    `  The graded policy used ${gradedAt10.meanForce.toFixed(1)} N on average, varying over ${gradedAt10.spread.toFixed(1)} N.\n` +
      `  A fixed ${BASE_FORCE} N cannot do that: it pushes just as hard when the pole is nearly\n` +
      `  upright as when it is falling, which is precisely what overshoots.\n`,
  );
}
