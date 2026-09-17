/**
 * CartPole x Jev.
 *
 * Jev's only job is to keep the pole up. Your only job is to knock it over.
 *
 * There is no competition and no takeover: the model is always the controller,
 * and you are a disturbance. Click either side of the cart and it takes a shove;
 * Jev then has to recover from a kick it could not have predicted.
 *
 * The shove is an impulse, and it reuses the verified dynamics rather than
 * inventing new physics: an impulse of J newton-seconds is delivered as
 *
 *     force = J / TAU        for exactly one 20 ms physics step
 *
 * so the coupling (the pole swinging because the cart was hit) falls out of the
 * same equations that test/compare.mjs checks against Gymnasium.
 *
 * Everything else follows the shape this project has always had:
 *
 *   - physics runs on a fixed 50 Hz timestep, in real time, scaled by sim speed
 *   - QUESTIONS is built once and re-sent unchanged on every decision
 *   - only `state` differs between calls
 *   - several questions are asked per call; a policy decides in plain JavaScript
 *     which answer drives the cart
 */

import {
  stepForce, resetState, MAX_STEPS, TAU, FORCE_MAG, X_THRESHOLD, THETA_THRESHOLD, toDegrees, describeState,
} from './cartpole.js';
import { REPRESENTATIONS, buildState } from './state.js';
import { QUESTIONS, POLICIES, questionChars } from './questions.js';
import { askJev, testConnection, DEFAULT_MODEL, BrowserBlockedError, ApiError } from './typesafe.js';

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- settings -- */

const LS_KEY = 'cartpole-jev-v3';

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { /* ignore */ }
  return {
    apiKey: '', model: DEFAULT_MODEL,
    representation: 'prose', policy: 'threshold',
    // Defaults chosen from measurement, not from the standard CartPole value.
    // Gymnasium applies an action every physics step (50/sec). This app holds
    // each decision, so at 10/sec a push is held 100 ms and NO force balances:
    // test/force-rate.mjs measured 42 at 10 N, 188 at 6 N, 68 at 4 N.
    // 4 N held for 2 steps (25 decisions/sec) scores a clean 500 for about half
    // the tokens of 10 N at every step. The force slider still goes to 20 N.
    rate: 25,
    simSpeed: 1,
    syncSpeed: true,           // derive simSpeed from the measured API latency
    shoveN: 1,                 // newton-seconds per click
    jevForceN: 4,              // newtons
    autorestart: true, verbose: false,
    ...saved,
  };
}

const settings = loadSettings();

function persist() {
  const { apiKey, model, representation, policy, rate, simSpeed, syncSpeed, shoveN, jevForceN, autorestart, verbose } = settings;
  localStorage.setItem(LS_KEY, JSON.stringify({
    apiKey, model, representation, policy, rate, simSpeed, syncSpeed, shoveN, jevForceN, autorestart, verbose,
  }));
}

const TOTAL_MASS_KG = 1.1;                 // cart 1.0 + pole 0.1, from cartpole.js
const accelOf = (N) => Math.abs(N) / TOTAL_MASS_KG;

/** Jev's push in newtons, signed: positive is to the right. */
const signedJevForce = () => (jevAction === 1 ? jevMagnitude : -jevMagnitude);

/**
 * How much simulation time one decision may cover.
 *
 * test/interval-limit.mjs: a hand-written controller scores 500 when it can act
 * every 2 steps (40 ms) and collapses past about 7. Two steps is the target.
 *
 * Without this the browser is structurally unable to balance. A call takes ~400
 * ms, so at sim speed 1 each decision covers ~20 physics steps whatever the
 * decisions/sec slider says -- a regime where even a perfect controller scores
 * 10. That slider is a request; the latency decides what actually happens, so
 * the world is slowed until one decision covers 40 ms of it.
 */
const TARGET_SIM_MS_PER_DECISION = 2 * TAU * 1000; // 40 ms
const MIN_SIM_SPEED = 0.02, MAX_SIM_SPEED = 4;

function effectiveSimSpeed() {
  if (!settings.syncSpeed || !stats.lastLatency) return settings.simSpeed;
  const want = TARGET_SIM_MS_PER_DECISION / stats.lastLatency;
  return Math.min(MAX_SIM_SPEED, Math.max(MIN_SIM_SPEED, want));
}

/* ------------------------------------------------------------------ state -- */

let state = resetState();
let jevAction = 1;
/**
 * Newtons for the current decision, unsigned.
 *
 * The fixed policies leave this at settings.jevForceN. The graded policy lets
 * the model set it per step from a Score, which is what turns bang-bang control
 * into something closer to proportional: a force that shrinks with the error
 * does far less damage over a long decision interval than a constant one.
 */
let jevMagnitude = 4;
let score = 0;
let running = false;
let inFlight = false;
let acc = 0;
let lastFrameAt = 0;
let lastDecisionAt = 0;
let trail = [];
let netForce = 0;

/**
 * Set the moment an episode ends, cleared only by startEpisode().
 *
 * Without this the simulation keeps stepping a state that is already out of
 * bounds, so every subsequent physics step reports terminated again and calls
 * endEpisode again. The symptoms are nasty and look like a model fault: the
 * episode counter and the score climb in lockstep, several "episode N started"
 * lines appear for the same N (each endEpisode queued its own restart timer),
 * and the pole seems to fall within a second of every restart.
 */
let episodeOver = false;
let restartTimer = null;

/** Newton-seconds queued for the very next physics step. */
let pendingShove = 0;
/** Screen position of the last click, for the ripple. */
let shoveFx = null;

/** A shove is "survived" if the episode lasts this many more steps. */
const RECOVERY_STEPS = 25; // 0.5 s

const stats = {
  episodes: 0, best: 0, total: 0,
  shoves: 0, recoveries: 0, knockdowns: 0, lostOnItsOwn: 0,
  lastShoveAt: -Infinity, unresolvedShove: false,
  decisions: 0, skipped: 0,
  inputTokens: 0, outputTokens: 0,
  latencySum: 0, lastLatency: 0, modelSeen: '',
};

const PRICE_PER_MTOK_INPUT = 0.042; // USD, TypeSafe early access; output is free
const money = (tokens) => `$${((tokens * PRICE_PER_MTOK_INPUT) / 1e6).toFixed(5)}`;

/* ---------------------------------------------------------------- logging -- */

const logEl = $('log');
let logCount = 0;

const clockStamp = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

function log(kind, html) {
  const entry = document.createElement('div');
  entry.className = `entry ${kind}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = clockStamp();
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.innerHTML = html;
  entry.append(t, msg);
  logEl.append(entry);
  if (++logCount > 500) { logEl.firstElementChild?.remove(); logCount--; }
  logEl.scrollTop = logEl.scrollHeight;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dirSpan = (v, text) => `<span class="${v >= 0 ? 'v-right' : 'v-left'}">${text}</span>`;

/* --------------------------------------------------------------- rendering -- */

const canvas = $('view');
const ctx = canvas.getContext('2d');
let viewW = 900, viewH = 420;

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  viewW = rect.width || 900;
  viewH = Math.round(viewW * (420 / 900));
  canvas.style.height = `${viewH}px`;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const WORLD_HALF = 3.1;                       // metres shown either side of centre
const SCALE = () => viewW / (WORLD_HALF * 2); // px per metre
const px = (m) => m * SCALE();
const pxToWorld = (clientX) => {
  const rect = canvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * WORLD_HALF * 2 - WORLD_HALF;
};

function forceArrow(x, y, dir, colour, len = 14) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dir * len, y - 6);
  ctx.lineTo(x + dir * len, y + 6);
  ctx.closePath();
  ctx.fill();
}

function render(now = 0) {
  const groundY = viewH * 0.8;
  const midX = viewW / 2;
  const s = SCALE();

  ctx.clearRect(0, 0, viewW, viewH);

  // track
  const trackHalf = px(X_THRESHOLD);
  ctx.fillStyle = '#151d29';
  ctx.fillRect(midX - trackHalf, groundY, trackHalf * 2, 6);
  ctx.fillStyle = '#1e2937';
  ctx.fillRect(midX - trackHalf - 24, groundY - 3, 24, 12);
  ctx.fillRect(midX + trackHalf, groundY - 3, 24, 12);

  const pivotX = midX + state.x * s;
  const poleLenPx = px(1.0);
  const cartW = px(0.5);
  const cartH = 22;

  // ---- angle protractor -------------------------------------------------
  // The pole spends almost all its time within a couple of degrees of upright,
  // so a bare stick against two failure lines tells you nothing: 0.5 degrees and
  // 3 degrees look identical. This gives it a scale -- a vertical reference, tick
  // marks every 3 degrees, and an arc from vertical to the pole with the number
  // on it, coloured by how close the pole is to the limit.
  const pivotY = groundY - cartH;
  const angleDeg = toDegrees(state.theta);
  const R = Math.max(56, Math.min(96, poleLenPx * 0.46));
  const frac = Math.min(1, Math.abs(angleDeg) / toDegrees(THETA_THRESHOLD));
  const arcColour = frac > 0.75 ? '#ef6b6b' : frac > 0.45 ? '#f0a04b' : '#45d6c3';

  // upright reference
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(pivotX, pivotY - R - 24);
  ctx.strokeStyle = 'rgba(143,163,186,.30)';
  ctx.setLineDash([2, 6]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // tick marks, the last one being the failure angle
  const limitDeg = toDegrees(THETA_THRESHOLD);
  for (const deg of [3, 6, 9, limitDeg]) {
    const isLimit = deg === limitDeg;
    for (const dir of [-1, 1]) {
      const a = -Math.PI / 2 + dir * ((deg * Math.PI) / 180);
      const inner = R + 6;
      const outer = R + (isLimit ? 15 : 9);
      ctx.beginPath();
      ctx.moveTo(pivotX + Math.cos(a) * inner, pivotY + Math.sin(a) * inner);
      ctx.lineTo(pivotX + Math.cos(a) * outer, pivotY + Math.sin(a) * outer);
      ctx.strokeStyle = isLimit ? 'rgba(239,107,107,.55)' : 'rgba(143,163,186,.28)';
      ctx.lineWidth = isLimit ? 2 : 1;
      ctx.stroke();
    }
  }

  // the arc from upright to wherever the pole actually is
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, R, -Math.PI / 2, -Math.PI / 2 + state.theta, state.theta < 0);
  ctx.strokeStyle = arcColour;
  ctx.lineWidth = 3;
  ctx.lineCap = 'butt';
  ctx.stroke();

  // the number, halfway round that arc
  const labelA = -Math.PI / 2 + state.theta / 2;
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.fillStyle = arcColour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `${angleDeg >= 0 ? '+' : '−'}${Math.abs(angleDeg).toFixed(1)}°`,
    pivotX + Math.cos(labelA) * (R + 26),
    pivotY + Math.sin(labelA) * (R + 26),
  );
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // pole-tip trail
  if (trail.length > 1) {
    ctx.beginPath();
    trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(69,214,195,.26)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // cart
  ctx.fillStyle = '#243040';
  ctx.strokeStyle = '#33445a';
  ctx.lineWidth = 1;
  roundRect(ctx, pivotX - cartW / 2, groundY - cartH, cartW, cartH, 5);
  ctx.fill();
  ctx.stroke();

  // Jev's push
  const jf = signedJevForce();
  forceArrow(pivotX + Math.sign(jf) * (cartW / 2 + 3), groundY - cartH * 0.5, Math.sign(jf), 'rgba(69,214,195,.9)');

  // shove ripple, fading
  if (shoveFx) {
    const age = (now - shoveFx.t) / 450;
    if (age >= 1) {
      shoveFx = null;
    } else {
      ctx.strokeStyle = `rgba(240,160,75,${(1 - age) * 0.9})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(shoveFx.x, shoveFx.y, 8 + age * 34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(240,160,75,${(1 - age) * 0.85})`;
      ctx.font = '600 13px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(shoveFx.dir > 0 ? '→ shove' : 'shove ←', shoveFx.x, shoveFx.y - 16 - age * 12);
      ctx.textAlign = 'left';
    }
  }

  // pole
  const a = -Math.PI / 2 + state.theta;
  const tipX = pivotX + Math.cos(a) * poleLenPx;
  const tipY = groundY - cartH + Math.sin(a) * poleLenPx;

  ctx.strokeStyle = '#5b6f88';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivotX, groundY - cartH);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.strokeStyle = state.theta >= 0 ? '#5aa9f0' : '#c98bf0';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(pivotX, groundY - cartH);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.fillStyle = '#8fa3ba';
  ctx.beginPath();
  ctx.arc(pivotX, groundY - cartH, 4, 0, Math.PI * 2);
  ctx.fill();

  trail.push({ x: tipX, y: tipY });
  if (trail.length > 110) trail.shift();

  // HUD. Every line advances `line`; hard-coded y values collided once, which
  // is how "synced to ..." ended up drawn on top of the Jev line.
  let line = 24;
  const advance = () => { line += 20; };

  ctx.font = '500 13px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#8593a6';
  ctx.fillText(`score ${score}`, 14, line); advance();
  ctx.fillText(`step ${score}/${MAX_STEPS}`, 14, line); advance();

  // What the controller actually gets, not what the slider asked for. The
  // requested rate is a wish; the API's latency decides the truth, and this is
  // the number that decides whether the pole can be held at all.
  const simNow = effectiveSimSpeed();
  const simMsPerDecision = (stats.lastLatency || 1000 / settings.rate) * simNow;
  const stepsPerDecision = simMsPerDecision / (TAU * 1000);
  const controllable = stepsPerDecision <= 4;
  ctx.fillStyle = controllable ? '#8593a6' : '#f0a04b';
  ctx.fillText(
    `each decision covers ${stepsPerDecision.toFixed(1)} physics steps (${simMsPerDecision.toFixed(0)} ms of sim)`,
    14, line,
  );
  advance();

  if (settings.syncSpeed && stats.lastLatency) {
    ctx.fillStyle = '#45d6c3';
    ctx.fillText(`sim ${simNow.toFixed(3)}x, slowed to match the ${stats.lastLatency} ms call`, 14, line);
    advance();
  } else {
    ctx.fillStyle = controllable ? '#5d6b7e' : '#f0a04b';
    ctx.fillText(
      controllable
        ? `real time at ${settings.simSpeed}x`
        : `real time is ${(1 / simNow).toFixed(1)}x too fast to control — enable the latency match`,
      14, line,
    );
    advance();
  }

  ctx.fillStyle = '#45d6c3';
  ctx.fillText(`Jev  ${jf > 0 ? '→' : '←'} ${jf > 0 ? '+' : '−'}${Math.abs(jf)} N  →  ${accelOf(jf).toFixed(1)} m/s²`, 14, line);
  advance();

  if (inFlight) {
    ctx.fillStyle = '#f0a04b';
    ctx.fillText('waiting for Jev…', 14, line);
  }

  // click hint, only until the first shove
  if (stats.shoves === 0 && st() !== 'running') {
    ctx.fillStyle = 'rgba(240,160,75,.75)';
    ctx.font = '500 14px ui-sans-serif, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('click either side of the cart to shove it', midX, groundY - cartH - poleLenPx - 26);
    ctx.textAlign = 'left';
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

const st = () => $('statusDot').dataset.state;

/* -------------------------------------------------------------- scoreboard -- */

let lastStatsRender = 0;

function renderStats(now = 0) {
  if (now - lastStatsRender < 120) return;
  lastStatsRender = now;

  const avgLatency = stats.decisions ? Math.round(stats.latencySum / stats.decisions) : 0;
  const mean = stats.episodes ? stats.total / stats.episodes : 0;

  $('stats').innerHTML = `
    <dt>Current score</dt><dd class="${score > 200 ? 'good' : ''}">${score}</dd>
    <dt>Best episode</dt><dd class="${stats.best >= 500 ? 'good' : ''}">${stats.best || '—'}</dd>
    <dt>Episodes</dt><dd>${stats.episodes}</dd>
    <dt>Mean score</dt><dd>${stats.episodes ? mean.toFixed(1) : '—'}</dd>
    <dt>Decisions</dt><dd>${stats.decisions}</dd>
    <dt>Skipped</dt><dd class="${stats.skipped > stats.decisions ? 'warn' : ''}">${stats.skipped}</dd>
    <dt>Last latency</dt><dd>${stats.lastLatency ? `${stats.lastLatency} ms` : '—'}</dd>
    <dt>Mean latency</dt><dd>${avgLatency ? `${avgLatency} ms` : '—'}</dd>
    <dt>Tokens in / out</dt><dd>${stats.inputTokens} / ${stats.outputTokens}</dd>
    <dt>Spend</dt><dd>${money(stats.inputTokens)}</dd>
    <dt>Model</dt><dd>${esc(stats.modelSeen || '—')}</dd>
  `;

  const survived = stats.shoves ? (stats.recoveries / stats.shoves) * 100 : null;
  const inFlightShove = stats.unresolvedShove;

  $('shoveStats').innerHTML = `
    <dt>Shoves delivered</dt><dd class="you">${stats.shoves}</dd>
    <dt>Recovered</dt><dd class="${stats.recoveries ? 'good' : ''}">${stats.recoveries}</dd>
    <dt>Shoves survived</dt><dd class="${survived !== null && survived >= 50 ? 'good' : 'warn'}">${survived === null ? '—' : `${survived.toFixed(0)}%`}</dd>
    <dt>Knocked over by you</dt><dd class="${stats.knockdowns ? 'you' : ''}">${stats.knockdowns}</dd>
    <dt>Lost on its own</dt><dd class="${stats.lostOnItsOwn ? 'warn' : ''}">${stats.lostOnItsOwn}</dd>
    ${inFlightShove ? '<dt>Latest shove</dt><dd class="warn">deciding…</dd>' : ''}
  `;

  $('shoveIntro').innerHTML = stats.shoves || stats.episodes
    ? `You have shoved the cart <strong>${stats.shoves}</strong> time${stats.shoves === 1 ? '' : 's'}: ` +
      `Jev held on for <strong>${stats.recoveries}</strong>, you put it over <strong>${stats.knockdowns}</strong>, ` +
      `and it lost <strong>${stats.lostOnItsOwn}</strong> without your help. A shove counts as survived if the episode lasts another half second.`
    : 'Click either side of the cart to knock it off balance, and see whether Jev can recover. ' +
      'A shove counts as survived if the episode lasts another half second.';
}

/* ----------------------------------------------------------- state preview -- */

let lastPreview = 0;
function renderPreview(now = 0) {
  if (now - lastPreview < 100) return;
  lastPreview = now;
  $('statePreview').textContent = JSON.stringify(buildState(state, settings.representation), null, 2);

  const d = describeState(state);
  $('readout').innerHTML = [
    `x <b>${d.x.toFixed(3)}</b>`,
    `ẋ <b>${d.xDot.toFixed(3)}</b>`,
    `θ <b>${d.angleDeg.toFixed(2)}°</b>`,
    `θ̇ <b>${d.angleRateDeg.toFixed(1)}°/s</b>`,
  ].join('');
}

/* ----------------------------------------------------------------- episodes -- */

/**
 * Reset the simulation without announcing an episode.
 *
 * Boot needs a valid state so the canvas has something to draw before anyone
 * presses Start, but that is not an episode and must not log one. Calling
 * startEpisode() at boot meant pressing Start logged "episode 1 started" twice.
 */
function primeState() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  episodeOver = false;
  state = resetState();
  score = 0;
  trail = [];
  jevAction = 1;
  jevMagnitude = settings.jevForceN;
  acc = 0;
  lastDecisionAt = 0;
  pendingShove = 0;
  stats.unresolvedShove = false;
}

function startEpisode() {
  primeState();
  log('episode', `episode ${stats.episodes + 1} started`);
}

function endEpisode(reason) {
  if (episodeOver) return; // a terminated state keeps reporting terminated
  episodeOver = true;

  stats.episodes++;
  stats.total += score;
  if (score > stats.best) stats.best = score;

  // Attribute the failure honestly. A shove that is still unresolved when the
  // pole goes over is yours; an episode that ends with no shove in flight means
  // Jev lost it by itself, and counting that as a knockdown would be a lie.
  const byYou = stats.unresolvedShove && reason === 'fell';
  if (byYou) stats.knockdowns++;
  else if (reason === 'fell') stats.lostOnItsOwn++;
  stats.unresolvedShove = false;

  const cap = score >= MAX_STEPS ? ' (hit the 500-step cap)' : '';
  log(
    'episode',
    `episode ${stats.episodes} ended after <span class="v-num">${score}</span> steps — ${reason}${cap}` +
      (byYou ? ' — <span class="v-left">you knocked it over</span>' : reason === 'fell' ? ' — <span class="v-dim">it lost this one on its own</span>' : ''),
  );
  trail = [];

  if (settings.autorestart && running) {
    restartTimer = setTimeout(() => { restartTimer = null; if (running) startEpisode(); }, 600);
  } else {
    stop();
  }
}

/* ------------------------------------------------------------------- shove -- */

/**
 * Deliver one impulse. Queued rather than applied immediately so that it lands
 * on exactly one physics step, whatever the sim speed is doing.
 */
function shove(dir, screenX, screenY) {
  if (!running) return;
  pendingShove = dir * settings.shoveN;

  const dv = settings.shoveN / TOTAL_MASS_KG;
  stats.shoves++;
  stats.lastShoveAt = score;
  stats.unresolvedShove = true;
  shoveFx = { x: screenX, y: screenY, dir, t: performance.now() };

  log(
    'warn',
    `${dir > 0 ? '→' : '←'} shove ${settings.shoveN} N·s at step ${score}  ` +
      `<span class="v-dim">cart gains ${dv.toFixed(2)} m/s instantly</span>`,
  );
}

/* ---------------------------------------------------------------- decisions -- */

function setStatus(v) { $('statusDot').dataset.state = v; }

async function decide() {
  inFlight = true;
  setStatus('thinking');

  const snapshot = { ...state };

  try {
    const out = await askJev({
      apiKey: $('apiKey').value.trim(),
      state: buildState(snapshot, settings.representation),
      questions: QUESTIONS,
      model: $('model').value.trim() || DEFAULT_MODEL,
    });

    const decision = POLICIES[settings.policy].decide(out.answers, jevAction, {
      baseForceN: settings.jevForceN,
    });
    jevAction = decision.action;
    jevMagnitude = decision.force ?? settings.jevForceN;

    stats.decisions++;
    stats.inputTokens += out.usage.input_tokens ?? 0;
    stats.outputTokens += out.usage.output_tokens ?? 0;
    stats.latencySum += out.latencyMs;
    stats.lastLatency = out.latencyMs;
    stats.modelSeen = out.model;

    const a = out.answers;
    log(
      'decision',
      `#${stats.decisions} Jev → ${dirSpan(decision.action === 1 ? 1 : -1, decision.action === 1 ? 'RIGHT' : 'LEFT')}` +
        ` at <span class="v-num">${jevMagnitude.toFixed(1)} N</span>` +
        ` <span class="k">p(right)</span>=<span class="v-num">${(a.push_right?.noul ?? NaN).toFixed(2)}</span>` +
        (a.push_force ? ` <span class="k">force</span>=<span class="v-num">${(a.push_force.score ?? NaN).toFixed(1)}</span>/3` : '') +
        ` <span class="k">instab</span>=<span class="v-num">${(a.instability?.score ?? NaN).toFixed(1)}</span>` +
        ` <span class="v-dim">${out.latencyMs}ms in=${out.usage.input_tokens ?? 0}</span>`,
    );

    if (settings.verbose) {
      log('raw', esc(JSON.stringify({ state: buildState(snapshot, settings.representation), answers: a }, null, 1)));
    }
  } catch (err) {
    stop();
    if (err instanceof BrowserBlockedError) {
      log('error', `<b>Could not reach the API.</b> ${esc(err.message)}`);
      log('warn', 'Start the app with <code>npx wrangler pages dev .</code> or <code>node tools/dev-proxy.mjs</code>.');
    } else if (err instanceof ApiError) {
      log('error', `<b>HTTP ${err.status}</b> — ${esc(err.message)}`);
      if (err.status === 401) log('warn', 'That usually means the API key is wrong or expired.');
      if (err.status === 400) log('warn', 'Schema error. Check “The question set sent every frame” above.');
      if (err.requestId) log('raw', `request id ${esc(err.requestId)}`);
    } else {
      log('error', esc(err?.message ?? String(err)));
    }
  } finally {
    inFlight = false;
    if (running) setStatus('running');
  }
}

/* --------------------------------------------------------------------- loop -- */

function frame(now) {
  const dt = Math.min((now - (lastFrameAt || now)) / 1000, 0.25);
  lastFrameAt = now;

  if (running && !episodeOver) {
    netForce = signedJevForce();

    acc += dt * effectiveSimSpeed();
    while (acc >= TAU) {
      acc -= TAU;

      // an impulse becomes one very strong push over one step
      let f = netForce;
      if (pendingShove !== 0) {
        f += pendingShove / TAU;
        pendingShove = 0;
      }

      const r = stepForce(state, f);
      state = r.state;
      score += r.reward;

      if (stats.unresolvedShove && score - stats.lastShoveAt >= RECOVERY_STEPS) {
        stats.unresolvedShove = false;
        stats.recoveries++;
        log('episode', `<span class="v-num">▲ recovered</span> from the shove at step ${stats.lastShoveAt}`);
      }

      if (r.terminated) { endEpisode('pole fell or cart left the track'); break; }
      if (score >= MAX_STEPS) { endEpisode('clean run'); break; }
    }

    const interval = 1000 / settings.rate;
    if (inFlight) {
      // count missed decisions, not the frames spent waiting for one
      if (now - lastDecisionAt >= interval) {
        stats.skipped += Math.floor((now - lastDecisionAt) / interval);
        lastDecisionAt = now;
      }
    } else if (now - lastDecisionAt >= interval) {
      lastDecisionAt = now;
      decide();
    }
  }

  render(now);
  renderPreview(now);
  renderStats(now);
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- controls -- */

function start() {
  if (running) return;
  if (!$('apiKey').value.trim()) { log('warn', 'Enter your TypeSafe API key first.'); return; }
  running = true;
  setStatus('running');
  $('btnStart').textContent = 'Pause';
  $('btnStart').dataset.running = 'true';
  startEpisode();
  log('episode', `running — ${settings.rate} decisions/sec, sim speed ${settings.simSpeed}×`);
}

function stop() {
  running = false;
  inFlight = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  setStatus('idle');
  $('btnStart').textContent = 'Start';
  $('btnStart').dataset.running = 'false';
}

/* ------------------------------------------------------------------ wiring -- */

function buildSegmented(container, options, current, onPick) {
  container.innerHTML = '';
  for (const [id, spec] of Object.entries(options)) {
    const b = document.createElement('button');
    b.textContent = spec.label;
    b.dataset.mode = id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === current));
    b.onclick = () => onPick(id);
    container.append(b);
  }
}

function wire() {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('rate').value = settings.rate;
  $('rateOut').textContent = settings.rate;
  $('speed').value = settings.simSpeed;
  $('speedOut').textContent = `${settings.simSpeed}×`;
  $('shove').value = settings.shoveN;
  $('shoveOut').textContent = `${settings.shoveN} N·s`;
  $('jevForce').value = settings.jevForceN;
  $('jevForceOut').textContent = `${settings.jevForceN} N`;
  $('autorestart').checked = settings.autorestart;
  $('verbose').checked = settings.verbose;

  $('apiKey').oninput = (e) => { settings.apiKey = e.target.value.trim(); persist(); };
  $('model').oninput = (e) => { settings.model = e.target.value.trim(); persist(); };
  $('rate').oninput = (e) => { settings.rate = +e.target.value; $('rateOut').textContent = settings.rate; persist(); };
  $('speed').oninput = (e) => { settings.simSpeed = +e.target.value; $('speedOut').textContent = `${settings.simSpeed}×`; persist(); };
  $('syncSpeed').checked = settings.syncSpeed;
  $('syncSpeed').onchange = (e) => {
    settings.syncSpeed = e.target.checked;
    $('speed').disabled = settings.syncSpeed;
    persist();
    log('episode', settings.syncSpeed
      ? 'sim speed now follows the measured API latency'
      : `sim speed fixed at ${settings.simSpeed}x — real time, which Jev cannot keep up with`);
  };
  $('speed').disabled = settings.syncSpeed;
  $('shove').oninput = (e) => { settings.shoveN = +e.target.value; $('shoveOut').textContent = `${settings.shoveN} N·s`; persist(); };
  $('jevForce').oninput = (e) => { settings.jevForceN = +e.target.value; $('jevForceOut').textContent = `${settings.jevForceN} N`; persist(); };
  $('autorestart').onchange = (e) => { settings.autorestart = e.target.checked; persist(); };
  $('verbose').onchange = (e) => { settings.verbose = e.target.checked; persist(); };

  $('btnStart').onclick = () => (running ? stop() : start());
  $('btnReset').onclick = () => {
    stop();
    Object.assign(stats, {
      episodes: 0, best: 0, total: 0, shoves: 0, recoveries: 0, knockdowns: 0, lostOnItsOwn: 0,
      decisions: 0, skipped: 0, inputTokens: 0, outputTokens: 0, latencySum: 0, lastLatency: 0,
      unresolvedShove: false,
    });
    startEpisode();
    log('episode', 'scoreboards reset');
  };
  $('btnClearLog').onclick = () => { logEl.innerHTML = ''; logCount = 0; };
  $('btnForget').onclick = () => { settings.apiKey = ''; $('apiKey').value = ''; persist(); log('warn', 'API key removed from this browser.'); };

  $('btnTest').onclick = async () => {
    $('btnTest').disabled = true;
    log('raw', 'testing connection…');
    try {
      const out = await testConnection({
        apiKey: $('apiKey').value.trim(),
        model: $('model').value.trim() || DEFAULT_MODEL,
      });
      log('episode', `connection OK — model <b>${esc(out.model)}</b>, ${out.latencyMs} ms, ${out.usage.input_tokens} input tokens`);
    } catch (err) {
      if (err instanceof BrowserBlockedError) log('error', `<b>Could not reach the API.</b> ${esc(err.message)}`);
      else if (err instanceof ApiError) log('error', `HTTP ${err.status} — ${esc(err.message)}`);
      else log('error', esc(err?.message ?? String(err)));
    } finally {
      $('btnTest').disabled = false;
    }
  };

  buildSegmented($('reprSeg'), REPRESENTATIONS, settings.representation, (id) => {
    settings.representation = id;
    $('reprHint').textContent = REPRESENTATIONS[id].hint;
    persist();
  });
  $('reprHint').textContent = REPRESENTATIONS[settings.representation].hint;

  buildSegmented($('policySeg'), POLICIES, settings.policy, (id) => {
    settings.policy = id;
    $('policyHint').textContent = POLICIES[id].hint;
    persist();
  });
  $('policyHint').textContent = POLICIES[settings.policy].hint;

  // --- the whole interaction: click a side of the cart to shove it ----------
  const HIT = 0.25; // metres around the cart that still counts as a direct hit
  const shoveHere = (clientX, clientY) => {
    const worldX = pxToWorld(clientX);
    const dx = worldX - state.x;
    const dir = Math.abs(dx) <= HIT ? (Math.sign(dx) || 1) : Math.sign(dx);
    const rect = canvas.getBoundingClientRect();
    shove(dir, clientX - rect.left, clientY - rect.top);
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    shoveHere(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = e.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const rect = canvas.getBoundingClientRect();
    shove(dir, rect.width / 2 + dir * 40, rect.height * 0.55);
  });

  $('questionPreview').textContent = JSON.stringify(QUESTIONS, null, 2);
  $('questionCost').textContent =
    `${questionChars()} characters, re-sent on every single decision. The API has no caching, ` +
    `so this is ~91% of the per-frame cost — shortening it is the cheapest optimisation available.`;

  window.addEventListener('resize', fitCanvas);
  document.addEventListener('visibilitychange', () => { lastFrameAt = 0; });
}

/* -------------------------------------------------------------------- boot -- */

fitCanvas();
wire();
primeState(); // draw something, but that is not episode 1
render();
requestAnimationFrame(frame);
log('raw', 'ready. Enter your TypeSafe API key, press Start, then click either side of the cart.');
