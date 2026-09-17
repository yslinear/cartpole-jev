#!/usr/bin/env node
/**
 * Can you actually beat Jev at its own game?
 *
 * In versus mode both sides push the same cart and the forces add. The obvious
 * adversarial strategy is simply to push the opposite way every time, which
 * cancels Jev's push to 0 N and lets the pole fall under gravity alone. This
 * measures how well that works, with reaction delays that range from impossible
 * (instant) to human.
 *
 * It also runs the same experiment with the "a person is fighting you" sentence
 * REMOVED from Jev's state, to show what that sentence is worth.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/versus-headless.mjs --episodes 2
 */

import { stepForce, resetState, MAX_STEPS, TAU, FORCE_MAG } from '../src/cartpole.js';
import { buildState } from '../src/state.js';
import { QUESTIONS, POLICIES } from '../src/questions.js';
import { askJev, DEFAULT_MODEL } from '../src/typesafe.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const EPISODES = Number(arg('episodes', 2));
const EVERY = Number(arg('every', 5));
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const SHARED_START = { x: 0.02, xDot: 0.01, theta: -0.03, thetaDot: 0.02 };
const PRICE = 0.042 / 1e6;
const jevForce = (a) => (a === 1 ? FORCE_MAG : -FORCE_MAG);

/**
 * @param tellJev      include the opponent sentence in the state
 * @param reactDelay   steps the opponent takes to notice Jev's current push
 *                     (0 = perfect counter, 5 = 100 ms, 15 = 300 ms human-ish)
 * @param humanForce   N the opponent can apply (-FORCE_MAG to FORCE_MAG)
 */
async function episode({ tellJev, reactDelay, humanForce }) {
  let state = { ...SHARED_START };
  let jevAction = 1;
  let score = 0;
  let tokens = 0;
  let ended = 'cap';
  const jevHistory = [];

  outer: while (true) {
    if (score % EVERY === 0) {
      const opponentNow = humanForce * counterSign(jevHistory, reactDelay);
      const out = await askJev({
        baseUrl: PROXY, apiKey: API_KEY, model: DEFAULT_MODEL,
        state: buildState({ ...state }, 'prose', { humanForce: tellJev ? opponentNow : null }),
        questions: QUESTIONS,
      });
      tokens += out.usage.input_tokens ?? 0;
      jevAction = POLICIES.threshold.decide(out.answers, jevAction).action;
    }

    for (let k = 0; k < EVERY; k++) {
      // the opponent mirrors whichever push Jev made reactDelay steps ago
      const sign = counterSign(jevHistory, reactDelay);
      const net = jevForce(jevAction) + humanForce * sign;
      const r = stepForce(state, net);
      state = r.state;
      score += r.reward;
      jevHistory.push(jevAction);
      if (r.terminated) { ended = 'fell'; break outer; }
      if (score >= MAX_STEPS) { ended = 'cap'; break outer; }
    }
  }
  return { score, tokens, ended };
}

/** What direction the opponent pushes: -1, 0 or +1. */
function counterSign(history, delay) {
  if (delay === null) return 0;                     // idle opponent: a solo baseline
  const idx = history.length - 1 - delay;
  const past = idx >= 0 ? history[idx] : history[history.length - 1] ?? 1;
  return past === 1 ? -1 : 1;                       // always push the other way
}

const rows = [];
const run = async (label, cfg, n = EPISODES) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await episode(cfg));
  const mean = out.reduce((a, r) => a + r.score, 0) / out.length;
  const caps = out.filter((r) => r.ended === 'cap').length;
  const tokens = Math.round(out.reduce((a, r) => a + r.tokens, 0) / out.length);
  rows.push({ label, mean, best: Math.max(...out.map((r) => r.score)), caps, n, tokens });
  process.stdout.write(`  ${label} → mean ${mean.toFixed(0)} (${caps}/${n} survived)\n`);
};

console.log(`\n  ${EPISODES} episodes per row, Jev deciding every ${EVERY} steps\n`);

await run('Jev alone, nobody touching the keys', { tellJev: true, reactDelay: null, humanForce: 0 });

await run('Jev with no idea you exist, you counter perfectly', { tellJev: false, reactDelay: 0, humanForce: FORCE_MAG });
await run('Jev told about you, you counter perfectly (0 ms)', { tellJev: true, reactDelay: 0, humanForce: FORCE_MAG });
await run('Jev told about you, you counter 100 ms late', { tellJev: true, reactDelay: 5, humanForce: FORCE_MAG });
await run('Jev told about you, you counter 300 ms late', { tellJev: true, reactDelay: 15, humanForce: FORCE_MAG });
await run('Jev told about you, you counter 500 ms late', { tellJev: true, reactDelay: 25, humanForce: FORCE_MAG });

console.log('\n  ' + '-'.repeat(84));
console.log(`  ${'scenario'.padEnd(50)} ${'mean'.padStart(6)} ${'best'.padStart(5)} ${'survived'.padStart(9)} ${'tok/ep'.padStart(8)}`);
console.log('  ' + '-'.repeat(84));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(50)} ${r.mean.toFixed(0).padStart(6)} ${String(r.best).padStart(5)} ` +
      `${String(`${r.caps}/${r.n}`).padStart(9)} ${String(r.tokens).padStart(8)}`,
  );
}
console.log('  ' + '-'.repeat(84));
console.log(
  '\n  A perfect counter keeps the net force at 0 N, so the cart coasts and the pole\n' +
    '  simply falls. Being told about the opponent is what lets Jev push FOR 20 N to\n' +
    '  break the deadlock -- when it cannot, its score collapses.\n',
);
