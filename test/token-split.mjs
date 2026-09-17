#!/usr/bin/env node
/**
 * Where does the per-frame token cost actually go?
 *
 * The TypeSafe API has no caching: every request re-sends the full question
 * spec. So the interesting split is "how much of the payload is the fixed
 * question set, and how much is the state that actually varies".
 *
 * Measures three payloads against the same question set:
 *   - a one-word state          -> essentially the question-set cost
 *   - the prose state           -> question set + prose
 *   - the raw JSON state        -> question set + raw
 */

import { QUESTIONS } from '../src/questions.js';
import { buildState } from '../src/state.js';
import { askJev, DEFAULT_MODEL } from '../src/typesafe.js';

const PROXY = process.env.PROXY ?? 'http://localhost:8787';
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error('Set TYPESAFE_API_KEY.'); process.exit(1); }

const sample = { x: 0.02, xDot: 0.01, theta: -0.03, thetaDot: 0.02 };

const ask = async (state) => {
  const out = await askJev({ baseUrl: PROXY, apiKey: KEY, model: DEFAULT_MODEL, state, questions: QUESTIONS });
  return out.usage.input_tokens;
};

const minimal = await ask('x');
const prose = await ask(buildState(sample, 'prose'));
const raw = await ask(buildState(sample, 'raw'));
const coarse = await ask(buildState(sample, 'coarse'));

const chars = (v) => JSON.stringify(v).length;
const qChars = chars(QUESTIONS);

console.log('\n  per-frame input tokens\n');
console.log(`  question set alone (measured)      ${String(minimal).padStart(6)} tokens`);
console.log(`  + prose state                      ${String(prose).padStart(6)} tokens   (+${prose - minimal})`);
console.log(`  + raw JSON state                   ${String(raw).padStart(6)} tokens   (+${raw - minimal})`);
console.log(`  + coarse state                     ${String(coarse).padStart(6)} tokens   (+${coarse - minimal})`);

console.log('\n  character counts (sent every frame, uncached)\n');
console.log(`  question set                       ${String(qChars).padStart(6)} chars`);
console.log(`  prose state                        ${String(chars(buildState(sample, 'prose'))).padStart(6)} chars`);
console.log(`  raw state                          ${String(chars(buildState(sample, 'raw'))).padStart(6)} chars`);
console.log(`  coarse state                       ${String(chars(buildState(sample, 'coarse'))).padStart(6)} chars`);

const share = ((minimal / prose) * 100).toFixed(0);
console.log(`\n  the fixed question set is ${share}% of a prose-state frame.`);
const perHour = (tokens, hz) => `$${((tokens * hz * 3600 * 0.042) / 1e6).toFixed(2)}`;
console.log(`  at 10 decisions/sec that is ${perHour(prose, 10)}/hour, of which ${perHour(minimal, 10)}/hour is re-sending the questions.\n`);
