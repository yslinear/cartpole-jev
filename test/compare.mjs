#!/usr/bin/env node
/**
 * Physics regression test: does src/cartpole.js reproduce Gymnasium exactly?
 *
 * Runs the JS implementation and the real Gymnasium side by side over 400 steps
 * of a PD balancing controller and asserts two things:
 *
 *   1. both take the SAME control decisions (the actions match 1:1)
 *   2. the resulting trajectories agree to within floating-point noise
 *
 * Requires gymnasium, e.g.:
 *     uv venv /tmp/cpenv --python 3.12 && uv pip install --python /tmp/cpenv/bin/python gymnasium
 *     PYTHON=/tmp/cpenv/bin/python node test/compare.mjs
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PYTHON = process.env.PYTHON ?? 'python3';
const TOLERANCE = 1e-6; // absolute; observed worst case is ~1e-7 on thetaDot

const run = (cmd, args) => execFileSync(cmd, args, { cwd: HERE, encoding: 'utf8' });

function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\s*(\d+)\s+a=(\d)\s+x=([-\d.]+)\s+xDot=([-\d.]+)\s+th=([-\d.]+)\s+thDot=([-\d.]+)/,
    );
    if (m) rows.push({ step: +m[1], action: +m[2], x: +m[3], xDot: +m[4], theta: +m[5], thetaDot: +m[6] });
  }
  return rows;
}

let jsText;
try {
  jsText = run('node', ['physics-check.mjs']);
} catch (err) {
  console.error('Could not run the JS harness:', err.message);
  process.exit(1);
}

let pyText;
try {
  pyText = run(PYTHON, ['reference.py']);
} catch (err) {
  console.error(`\n  Skipping: could not run the Gymnasium reference with "${PYTHON}".`);
  console.error(`  ${String(err.stderr ?? err.message).split('\n')[0]}`);
  console.error('  Set PYTHON=/path/to/venv/bin/python once gymnasium is installed.\n');
  process.exit(2);
}

const js = parse(jsText);
const py = parse(pyText);

if (js.length === 0 || py.length === 0) {
  console.error('Parsed no rows. Did the output format change?');
  process.exit(1);
}

const n = Math.min(js.length, py.length);
let actionMismatches = 0;
let worst = { field: '', value: 0, step: 0 };

for (let i = 0; i < n; i++) {
  if (js[i].action !== py[i].action) actionMismatches++;
  for (const f of ['x', 'xDot', 'theta', 'thetaDot']) {
    const d = Math.abs(js[i][f] - py[i][f]);
    if (d > worst.value) worst = { field: f, value: d, step: js[i].step };
  }
}

console.log(`\n  CartPole physics: JS vs Gymnasium`);
console.log(`  samples compared .......... ${n}`);
console.log(`  control actions differing .. ${actionMismatches}`);
console.log(`  worst divergence .......... ${worst.value.toExponential(2)} on ${worst.field} @ step ${worst.step}`);
console.log(`  tolerance ................. ${TOLERANCE.toExponential(2)}`);

if (actionMismatches > 0) {
  console.error(`\n  FAIL: the two implementations made different control decisions.\n`);
  process.exit(1);
}
if (worst.value > TOLERANCE) {
  console.error(`\n  FAIL: divergence exceeds tolerance. This is a real porting bug, not rounding.\n`);
  process.exit(1);
}

console.log(`\n  PASS — identical decisions, trajectories agree to floating-point precision.\n`);
