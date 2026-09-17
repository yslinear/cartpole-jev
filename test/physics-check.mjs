/**
 * Deterministic trajectory dump for the physics port.
 *
 * Run:  node test/physics-check.mjs
 * Compares against test/reference.py, which uses the real Gymnasium if available.
 */

import { step, TAU } from '../src/cartpole.js';

// Fixed, reproducible start state (radians for the pole quantities).
let state = { x: 0.01, xDot: -0.02, theta: 0.03, thetaDot: 0.0 };

// A simple PD balancing rule keeps the pole up for the whole run, so the two
// implementations are compared over a long, non-trivial trajectory instead of
// over the ten steps it takes to knock the pole over.
const GAIN = Number(process.env.GAIN ?? 0.2);
const controller = (s) => (s.theta + GAIN * s.thetaDot > 0 ? 1 : 0);

const lines = [];
for (let i = 0; i < 400; i++) {
  const a = controller(state);
  const r = step(state, a);
  state = r.state;
  if (i % 20 === 19 || r.terminated) {
    lines.push(
      `${String(i + 1).padStart(4)}  a=${a}  x=${state.x.toFixed(10)}  xDot=${state.xDot.toFixed(10)}  ` +
        `th=${state.theta.toFixed(10)}  thDot=${state.thetaDot.toFixed(10)}  terminated=${r.terminated}`,
    );
  }
  if (r.terminated) break;
}

console.log(`tau=${TAU}  steps=${lines.length ? lines.length : 0}`);
console.log(lines.join('\n'));
