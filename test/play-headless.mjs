#!/usr/bin/env node
/**
 * Does Jev actually balance the pole?
 *
 * Real CartPole episodes, real API calls (via the dev proxy), compared against
 * two baselines: random actions and the five-line PD heuristic that
 * test/compare.mjs already validated against Gymnasium.
 *
 * Decisions are synchronous here: the simulation pauses while we wait for the
 * answer. That isolates control quality from network latency. The browser app
 * deliberately does NOT pause -- it runs physics in real time so you can watch
 * the actuation delay hurt.
 *
 * The baselines are evaluated at the SAME decision interval as Jev, so
 * "PD, every 20 steps" holds its action for 20 steps exactly like Jev does.
 * That is the honest comparison.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/play-headless.mjs --episodes 3 --every 5
 */

import { step, resetState, MAX_STEPS } from '../public/src/cartpole.js';
import { buildState } from '../public/src/state.js';
import { QUESTIONS, POLICIES } from '../public/src/questions.js';
import { askJev, DEFAULT_MODEL } from '../public/src/typesafe.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const EPISODES = Number(arg('episodes', 3));
const EVERY = Number(arg('every', 5));
const REPRESENTATION = arg('repr', 'prose');
const POLICY = arg('policy', 'threshold');
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const API_KEY = process.env.TYPESAFE_API_KEY;

if (!API_KEY) {
  console.error('Set TYPESAFE_API_KEY.');
  process.exit(1);
}

/** Fixed start state so every policy faces the identical situation. */
const SHARED_START = { x: 0.02, xDot: 0.01, theta: -0.03, thetaDot: 0.02 };

/**
 * One episode. `decider(state, prevAction)` returns {action, tokens}.
 *
 * The loop exits on EITHER termination or the step cap. Getting this wrong is
 * how a harness silently reports 500 for a policy that actually fell over at
 * step 40 -- the score just keeps accumulating past the failure.
 */
async function runEpisode({ decider, every }) {
  let state = { ...SHARED_START };
  let action = 1;
  let score = 0;
  let tokens = 0;
  let decisions = 0;
  let ended = 'cap';

  outer: while (true) {
    if (score % every === 0) {
      const d = await decider(state, action);
      action = d.action;
      tokens += d.tokens ?? 0;
      decisions++;
    }
    for (let k = 0; k < every; k++) {
      const r = step(state, action);
      state = r.state;
      score += r.reward;
      if (r.terminated) { ended = 'fell'; break outer; }
      if (score >= MAX_STEPS) { ended = 'cap'; break outer; }
    }
  }
  return { score, tokens, decisions, ended };
}

const randomDecider = async () => ({ action: Math.random() < 0.5 ? 0 : 1, tokens: 0 });
const pdDecider = async (s) => ({ action: s.theta + 0.2 * s.thetaDot > 0 ? 1 : 0, tokens: 0 });

const jevDecider = async (state, prevAction) => {
  const out = await askJev({
    baseUrl: PROXY,
    apiKey: API_KEY,
    state: buildState({ ...state }, REPRESENTATION),
    questions: QUESTIONS,
    model: DEFAULT_MODEL,
  });
  return { action: POLICIES[POLICY].decide(out.answers, prevAction).action, tokens: out.usage.input_tokens ?? 0 };
};

/* ------------------------------------------------------------------- run -- */

const rows = [];

const rRandom = await runEpisode({ decider: randomDecider, every: 1 });
rows.push({ label: 'random actions (every step)', ...rRandom });

const rPd = await runEpisode({ decider: pdDecider, every: 1 });
rows.push({ label: 'PD heuristic (every step)', ...rPd });

const rPdHeld = await runEpisode({ decider: pdDecider, every: EVERY });
rows.push({ label: `PD heuristic, held ${EVERY} steps`, ...rPdHeld });

for (let i = 0; i < EPISODES; i++) {
  process.stdout.write(`  Jev ${i + 1}/${EPISODES} (every ${EVERY} steps, ${REPRESENTATION})… `);
  const r = await runEpisode({ decider: jevDecider, every: EVERY });
  console.log(`score ${String(r.score).padStart(3)} (${r.ended})`);
  rows.push({ label: `Jev #${i + 1}`, ...r });
}

const PRICE = 0.042 / 1e6;
console.log('\n  policy                                    score  ended   decisions     tokens      cost');
console.log('  ' + '-'.repeat(88));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(38)}  ${String(r.score).padStart(5)}  ${r.ended.padEnd(6)}  ` +
      `${String(r.decisions).padStart(9)}  ${String(r.tokens).padStart(10)}  $${(r.tokens * PRICE).toFixed(5)}`,
  );
}

const jev = rows.filter((r) => r.label.startsWith('Jev'));
if (jev.length) {
  const avg = jev.reduce((a, r) => a + r.score, 0) / jev.length;
  console.log(
    `\n  Jev mean ${avg.toFixed(1)}  |  PD held ${EVERY} steps: ${rPdHeld.score} (${rPdHeld.ended})  |  ` +
      `random: ${rRandom.score}`,
  );
}
console.log();
