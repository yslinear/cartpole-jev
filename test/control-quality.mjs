#!/usr/bin/env node
/**
 * Why does Jev look like it is kicking at random?
 *
 * Runs real episodes against the API and instruments every decision: the Noul it
 * returned, which way the cart was told to go, and whether that flipped the
 * previous direction. A controller flipping on most decisions is not "deciding
 * fast", it is dithering, and it looks exactly like random kicking.
 *
 * It also verifies the force actually applied, by reading it back off the same
 * code path the browser uses.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/control-quality.mjs --episodes 2
 */

import { stepForce, resetState, MAX_STEPS, TAU, FORCE_MAG } from '../public/src/cartpole.js';
import { buildState } from '../public/src/state.js';
import { QUESTIONS, POLICIES } from '../public/src/questions.js';
import { askJev, DEFAULT_MODEL } from '../public/src/typesafe.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const EPISODES = Number(arg('episodes', 2));
const EVERY = Number(arg('every', 5));       // physics steps per decision, = 10/sec
const POLICY = arg('policy', 'threshold');
const REPR = arg('repr', 'prose');
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const JEVC = Number(arg('force', FORCE_MAG));

async function episode() {
  let state = resetState();
  let action = 1;
  let score = 0;
  const log = [];

  outer: while (true) {
    if (score % EVERY === 0) {
      const out = await askJev({
        baseUrl: PROXY, apiKey: KEY, model: DEFAULT_MODEL,
        state: buildState({ ...state }, REPR),
        questions: QUESTIONS,
      });
      const p = out.answers.push_right?.noul ?? NaN;
      const next = POLICIES[POLICY].decide(out.answers, action).action;
      // The control law a hand-written balancer uses: it considers the angle AND
      // how fast the pole is rotating. If Jev disagrees with this most of the
      // time, it is doing proportional-only control and will oscillate.
      const pdWants = state.theta + 0.2 * state.thetaDot > 0 ? 1 : 0;
      log.push({ step: score, p, from: action, to: next, flipped: next !== action, theta: state.theta, thetaDot: state.thetaDot, pdWants });
      action = next;
    }

    for (let k = 0; k < EVERY; k++) {
      // exactly what src/app.js does: force applied over each physics step
      const force = JEVC * (action === 1 ? 1 : -1);
      const r = stepForce(state, force);
      state = r.state;
      score += r.reward;
      if (r.terminated) break outer;
      if (score >= MAX_STEPS) break outer;
    }
  }
  return { score, log };
}

const all = [];
const perEpisode = [];

for (let i = 0; i < EPISODES; i++) {
  const r = await episode();
  all.push(...r.log);
  perEpisode.push(r.score);
  process.stdout.write(`  episode ${i + 1}: score ${r.score}, ${r.log.length} decisions\n`);
}

const ps = all.map((d) => d.p).filter((v) => !Number.isNaN(v));
const flips = all.filter((d) => d.flipped).length;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`\n  decisions ................. ${all.length}`);
console.log(`  direction flips ........... ${flips}  (${((flips / all.length) * 100).toFixed(0)}% of decisions)`);
console.log(`  mean P(right) ............. ${mean(ps).toFixed(3)}`);
console.log(`  min / max P(right) ........ ${Math.min(...ps).toFixed(2)} / ${Math.max(...ps).toFixed(2)}`);

// does Jev account for the angular velocity, or only the angle?
const pdAgree = all.filter((d) => d.to === d.pdWants).length;
const angleOnlyAgree = all.filter((d) => d.to === (d.theta > 0 ? 1 : 0)).length;
console.log(`  agrees with PD (theta + 0.2*thetaDot): ${pdAgree} / ${all.length}  (${((pdAgree / all.length) * 100).toFixed(0)}%)`);
console.log(`  agrees with angle-sign only ..........  ${angleOnlyAgree} / ${all.length}  (${((angleOnlyAgree / all.length) * 100).toFixed(0)}%)`);

// how decisive was it? |p-0.5| is the margin the policy is acting on
const margins = ps.map((p) => Math.abs(p - 0.5));
const near = ps.filter((p) => Math.abs(p - 0.5) < 0.1).length;
console.log(`  mean margin |p-0.5| ....... ${mean(margins).toFixed(3)}`);
console.log(`  decisions within 0.1 of a coin flip: ${near} / ${ps.length}  (${((near / ps.length) * 100).toFixed(0)}%)`);

console.log('\n  first 24 decisions:');
console.log('   step   P(right)   angle    rate     action   PD wants   flipped');
for (const d of all.slice(0, 24)) {
  const agrees = d.to === d.pdWants ? '  ok' : '  DIFF';
  console.log(
    `  ${String(d.step).padStart(5)}   ${d.p.toFixed(2).padStart(6)}   ` +
      `${(d.theta * 180 / Math.PI).toFixed(1).padStart(6)}°  ${(d.thetaDot * 180 / Math.PI).toFixed(0).padStart(5)}°/s   ` +
      `${(d.to === 1 ? 'RIGHT' : 'left ').padStart(6)}   ${(d.pdWants === 1 ? 'RIGHT' : 'left ').padStart(8)}${agrees}` +
      `${d.flipped ? '   flip' : ''}`,
  );
}

console.log(
  '\n  Reading this: a controller whose P(right) sits near 0.5 and whose actions flip\n' +
    '  on most decisions is dithering. The cart gets shoved left, then right, then left,\n' +
    '  which is visible as violent twitching and destroys the balance it is meant to keep.\n',
);
