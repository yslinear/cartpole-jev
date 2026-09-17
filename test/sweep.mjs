#!/usr/bin/env node
/**
 * Sweep: how does Jev's CartPole score depend on the decision interval, the
 * state representation, and the policy that consumes its answers?
 *
 * Every row is real API calls. The two baseline rows are the reference points
 * that matter: what random play scores, and what a five-line PD controller
 * scores when forced to hold its decision for the same number of steps.
 *
 * Usage:
 *     node tools/dev-proxy.mjs &
 *     TYPESAFE_API_KEY=... node test/sweep.mjs --runs 3
 */

import { step, MAX_STEPS } from '../public/src/cartpole.js';
import { buildState } from '../public/src/state.js';
import { QUESTIONS, POLICIES } from '../public/src/questions.js';
import { askJev, DEFAULT_MODEL } from '../public/src/typesafe.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const RUNS = Number(arg('runs', 3));
const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const SHARED_START = { x: 0.02, xDot: 0.01, theta: -0.03, thetaDot: 0.02 };
const PRICE = 0.042 / 1e6;

async function runEpisode({ decider, every }) {
  let state = { ...SHARED_START };
  let action = 1, score = 0, tokens = 0, decisions = 0, ended = 'cap';

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

const pd = (s) => (s.theta + 0.2 * s.thetaDot > 0 ? 1 : 0);
const makeJev = (repr, policy) => async (state, prev) => {
  const out = await askJev({
    baseUrl: PROXY, apiKey: API_KEY, model: DEFAULT_MODEL,
    state: buildState({ ...state }, repr),
    questions: QUESTIONS,
  });
  return { action: POLICIES[policy].decide(out.answers, prev).action, tokens: out.usage.input_tokens ?? 0 };
};

async function mean(decider, every, runs = RUNS) {
  const scores = [], tokens = [];
  let caps = 0;
  for (let i = 0; i < runs; i++) {
    const r = await runEpisode({ decider, every });
    scores.push(r.score);
    tokens.push(r.tokens);
    if (r.ended === 'cap') caps++;
  }
  return {
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    best: Math.max(...scores),
    worst: Math.min(...scores),
    caps,
    tokens: Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length),
    n: runs,
  };
}

const rows = [];
const push = (group, label, m) => rows.push({ group, label, ...m });

console.log(`\n  running ${RUNS} episodes per configuration...\n`);

/* ------------------------------------------------------------- baselines -- */
for (const every of [1, 5, 10, 20]) {
  push('baseline', `random, decision held ${every} steps`, await mean(async () => ({ action: Math.random() < 0.5 ? 0 : 1, tokens: 0 }), every));
  push('baseline', `PD heuristic, decision held ${every} steps`, await mean(async (s) => ({ action: pd(s), tokens: 0 }), every));
  process.stdout.write(`  baselines @ every=${every} done\n`);
}

/* ------------------------------------------------------------ interval --- */
for (const every of [1, 5, 10, 20]) {
  push('interval', `prose / threshold @ every ${every}`, await mean(makeJev('prose', 'threshold'), every));
  process.stdout.write(`  interval ${every} done\n`);
}

/* ------------------------------------------------------ representation --- */
for (const repr of ['prose', 'raw', 'coarse']) {
  push('repr', `${repr} / threshold @ every 5`, await mean(makeJev(repr, 'threshold'), 5));
  process.stdout.write(`  repr ${repr} done\n`);
}

/* -------------------------------------------------------------- policy --- */
for (const policy of ['threshold', 'gated', 'choice', 'composite']) {
  push('policy', `prose / ${policy} @ every 5`, await mean(makeJev('prose', policy), 5));
  process.stdout.write(`  policy ${policy} done\n`);
}

/* ---------------------------------------------------------------- print --- */
let lastGroup = '';
console.log('\n  ' + '-'.repeat(94));
console.log(`  ${'configuration'.padEnd(44)} ${'mean'.padStart(6)} ${'best'.padStart(5)} ${'worst'.padStart(6)} ${'caps'.padStart(5)} ${'tok/ep'.padStart(8)} ${'cost'.padStart(9)}`);
console.log('  ' + '-'.repeat(94));
for (const r of rows) {
  if (r.group !== lastGroup) {
    console.log(`  · ${r.group}`);
    lastGroup = r.group;
  }
  const bar = '█'.repeat(Math.max(0, Math.round(r.mean / 25)));
  console.log(
    `    ${r.label.padEnd(42)} ${r.mean.toFixed(0).padStart(6)} ${String(r.best).padStart(5)} ` +
      `${String(r.worst).padStart(6)} ${String(`${r.caps}/${r.n}`).padStart(5)} ${String(r.tokens).padStart(8)} $${(r.tokens * PRICE).toFixed(5).padStart(8)}  ${bar}`,
  );
}
console.log('  ' + '-'.repeat(94) + '\n');
