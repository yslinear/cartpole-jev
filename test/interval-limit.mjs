#!/usr/bin/env node
/**
 * The control-theoretic ceiling of this environment.
 *
 * CartPole's action is a constant 10 N push, not a proportional force. Holding
 * any decision for too many 20 ms steps overcorrects and destabilises the pole.
 * This measures that limit with a perfect hand-written controller, which is the
 * yardstick any learned or model-based controller has to be read against:
 * beyond a certain decision interval, NOTHING can play this game.
 *
 * No API calls. Run:  node test/interval-limit.mjs
 */

import { step, MAX_STEPS } from '../public/src/cartpole.js';

const START = { x: 0.02, xDot: 0.01, theta: -0.03, thetaDot: 0.02 };
const pd = (s) => (s.theta + 0.2 * s.thetaDot > 0 ? 1 : 0);

function run(every, decider) {
  let state = { ...START };
  let action = decider(state);
  let score = 0;
  let ended = 'cap';

  outer: while (true) {
    if (score % every === 0) action = decider(state);
    for (let k = 0; k < every; k++) {
      const r = step(state, action);
      state = r.state;
      score += r.reward;
      if (r.terminated) { ended = 'fell'; break outer; }
      if (score >= MAX_STEPS) { ended = 'cap'; break outer; }
    }
  }
  return { score, ended };
}

const bar = (n) => '█'.repeat(Math.max(0, Math.round(n / 25))).padEnd(20, '·');

console.log('\n  PD heuristic, decision held for N physics steps (N x 20 ms)\n');
console.log('   N    hold time    score  ended   score');
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30]) {
  const r = run(n, pd);
  console.log(
    `  ${String(n).padStart(2)}   ${String(n * 20).padStart(5)} ms   ${String(r.score).padStart(5)}  ${r.ended.padEnd(5)}   ${bar(r.score)}`,
  );
}

console.log('\n  For reference, random actions held for the same interval:\n');
console.log('   N    hold time    mean over 40 runs');
for (const n of [1, 5, 10, 20]) {
  const scores = Array.from({ length: 40 }, () => run(n, () => (Math.random() < 0.5 ? 0 : 1)).score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  console.log(`  ${String(n).padStart(2)}   ${String(n * 20).padStart(5)} ms   ${mean.toFixed(1).padStart(6)}   ${bar(mean)}`);
}

console.log(
  '\n  Read this before judging any controller on CartPole: past roughly\n' +
    '  100–140 ms of held action, the pole is unrecoverable and every policy\n' +
    '  scores ~10. A low score there says nothing about the policy.\n',
);
