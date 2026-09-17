#!/usr/bin/env node
/**
 * The browser's real constraint, and why syncSpeed exists.
 *
 * A headless sweep that decides synchronously can reach 25 decisions/sec. The
 * browser cannot: one API call takes a few hundred milliseconds, and the page
 * runs physics on the wall clock. At sim speed 1, a 400 ms call therefore covers
 * ~20 physics steps no matter what the decisions/sec slider says -- a regime in
 * which test/interval-limit.mjs shows even a PERFECT controller scores 10.
 *
 * This reproduces that: a hand-written PD controller, the best possible player,
 * with a fixed call latency and either wall-clock or latency-matched simulation.
 *
 * Note the loop structure. A `break` inside the step loop alone does not end the
 * episode -- a terminated state keeps reporting terminated, so the score climbs
 * past MAX_STEPS and the harness lies to you. That bug has been written twice in
 * this project, once in src/app.js and once in a throwaway script, so it is
 * spelled out here on purpose.
 *
 * Run:  node test/latency-reality.mjs
 */

import { stepForce, resetState, MAX_STEPS, TAU } from '../public/src/cartpole.js';

const LATENCY_MS = Number(process.env.LATENCY_MS ?? 400);
const TARGET_SIM_MS_PER_DECISION = 2 * TAU * 1000; // 40 ms, the rate PD survives
const SIM_BUDGET_MS = 60_000;                      // simulation time before we give up

/** A perfect controller. This is the upper bound for anything model-driven. */
const pd = (s) => (s.theta + 0.2 * s.thetaDot > 0 ? 1 : 0);

function play({ sync, force = 4 }) {
  let state = resetState();
  let action = pd(state);
  let score = 0;
  let peak = 0;
  let simMs = 0;
  let simSpeed = 1;
  let ended = 'budget';
  const simSpeeds = [];

  // Exactly one decision per loop, covering the simulation time that the call's
  // wall-clock latency buys at the current sim speed.
  while (simMs < SIM_BUDGET_MS) {
    simSpeed = sync
      ? Math.max(0.02, Math.min(4, TARGET_SIM_MS_PER_DECISION / LATENCY_MS))
      : 1;
    simSpeeds.push(simSpeed);

    const stepsThisDecision = Math.max(1, Math.round((LATENCY_MS * simSpeed) / (TAU * 1000)));
    action = pd(state); // a perfect controller reacts with no extra delay

    let done = false;
    for (let k = 0; k < stepsThisDecision; k++) {
      const r = stepForce(state, force * (action === 1 ? 1 : -1));
      state = r.state;
      score += r.reward;
      simMs += TAU * 1000;
      peak = Math.max(peak, Math.abs(state.theta) * 180 / Math.PI);
      if (r.terminated) { ended = 'fell'; done = true; break; }
      if (score >= MAX_STEPS) { ended = 'cap'; done = true; break; }
    }
    // The inner break is not enough: without this the loop keeps stepping a
    // terminated state and the reported score is meaningless.
    if (done) break;
  }

  return { score, ended, peak, simSpeed, stepsPerDecision: Math.max(1, Math.round((LATENCY_MS * simSpeeds[0]) / (TAU * 1000))) };
}

const off = play({ sync: false });
const on = play({ sync: true });

console.log(`\n  fixed API latency: ${LATENCY_MS} ms per decision`);
console.log(`  controller: a hand-written PD rule (no model error at all)\n`);
console.log(`  ${'simulation'.padEnd(26)} ${'steps/decision'.padStart(14)} ${'sim speed'.padStart(10)} ${'score'.padStart(6)} ${'ended'.padStart(7)}  peak |angle|`);
console.log('  ' + '-'.repeat(84));
for (const [label, r] of [['wall clock (syncSpeed off)', off], ['matched to latency (on)', on]]) {
  console.log(
    `  ${label.padEnd(26)} ${String(r.stepsPerDecision).padStart(14)} ${(r.simSpeed.toFixed(2) + 'x').padStart(10)} ` +
      `${String(r.score).padStart(6)} ${r.ended.padStart(7)}  ${r.peak.toFixed(1)}°`,
  );
}
console.log('  ' + '-'.repeat(84));
console.log(
  `\n  With the world running in real time, one decision covers ` +
    `${off.stepsPerDecision} physics steps and the best controller alive cannot hold the pole.\n` +
    `  Matched to the latency it covers ${on.stepsPerDecision}, which is inside the range interval-limit.mjs\n` +
    `  measured as controllable. Nothing about the model changes between those two rows.\n`,
);
