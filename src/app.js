/**
 * CartPole x Jev -- with a human fighting for the cart.
 *
 * Three modes:
 *
 *   jev     the model alone balances the pole                  (the baseline)
 *   human   you alone balance it, no API calls                 (your baseline)
 *   versus  BOTH push the same cart at the same time
 *
 * The versus mode is force addition, not a takeover:
 *
 *   net force = (jev pushing right ? +10 : -10) + (you holding a key ? +/-10 : 0)
 *
 * so opposing pushes cancel to 0 N and the cart simply coasts while the pole
 * falls. With nobody touching the keys, the arithmetic degenerates to the stock
 * CartPole action and the Gymnasium equivalence still holds exactly.
 *
 * Jev is told about you in the state it receives (see src/state.js). If that
 * sentence were removed it would have no way to know its pushes were being
 * cancelled -- which is the whole point of the mode.
 */

import {
  stepForce, resetState, MAX_STEPS, TAU, FORCE_MAG, X_THRESHOLD, THETA_THRESHOLD, toDegrees, describeState,
} from './cartpole.js';
import { REPRESENTATIONS, buildState } from './state.js';
import { QUESTIONS, POLICIES, questionChars } from './questions.js';
import { askJev, testConnection, DEFAULT_MODEL, BrowserBlockedError, ApiError } from './typesafe.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ modes -- */

const MODES = {
  jev: {
    label: 'Jev alone',
    hint: 'The model decides and the cart is pushed by it alone. This is the baseline the versus score is measured against.',
  },
  human: {
    label: 'You alone',
    hint: 'Hold ← / → (or A / D) to push. No API calls are made, so this is free — and it is your own baseline.',
  },
  versus: {
    label: 'Versus',
    hint: 'You and Jev push the same cart at once. Forces add: pushing against it cancels to 0 N and the cart coasts. Jev is told what you are doing — see if you can still beat it.',
  },
};

/* --------------------------------------------------------------- settings -- */

const LS_KEY = 'cartpole-jev-v2';

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { /* ignore */ }
  return {
    apiKey: '', model: DEFAULT_MODEL,
    representation: 'prose', policy: 'threshold',
    controlMode: 'jev',
    // Newtons each side may apply. Default is FORCE_MAG, the standard CartPole
    // value, so at the defaults the physics is still exactly Gymnasium's.
    jevForceN: FORCE_MAG,
    humanForceN: FORCE_MAG,
    rate: 10, simSpeed: 1, autorestart: true, verbose: false,
    ...saved,
  };
}

const settings = loadSettings();

function persist() {
  const { apiKey, model, representation, policy, controlMode, rate, simSpeed, autorestart, verbose, jevForceN, humanForceN } = settings;
  localStorage.setItem(LS_KEY, JSON.stringify({
    apiKey, model, representation, policy, controlMode, rate, simSpeed, autorestart, verbose, jevForceN, humanForceN,
  }));
}

/* ------------------------------------------------------------ human input -- */

const human = { left: false, right: false };

/** Total mass, so the UI can show what a given push actually does to the cart. */
const TOTAL_MASS_KG = 1.1;

/** -N, 0 or +N newtons. Holding both keys cancels out, which reads as "let go". */
function humanForce() {
  const n = settings.humanForceN;
  return (human.left ? -n : 0) + (human.right ? n : 0);
}

/** What Jev pushes with, or 0 when it is not in control. */
function jevForce() {
  if (settings.controlMode === 'human') return 0;
  return jevAction === 1 ? settings.jevForceN : -settings.jevForceN;
}

const humanPushing = () => settings.controlMode !== 'jev' && humanForce() !== 0;

/* ------------------------------------------------------------------ state -- */

let state = resetState();
let jevAction = 1;
let score = 0;
let running = false;
let inFlight = false;
let acc = 0;
let lastFrameAt = 0;
let lastDecisionAt = 0;
let trail = [];
let netForce = 0;
let episodeMode = 'jev';

/** Per-mode scoreboards, so the three modes never contaminate each other. */
const boards = {
  jev: { episodes: 0, total: 0, best: 0 },
  human: { episodes: 0, total: 0, best: 0 },
  versus: { episodes: 0, total: 0, best: 0 },
};

const stats = {
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

const WORLD_HALF = 3.1;
const px = (m) => (m / (WORLD_HALF * 2)) * viewW;

/** A little force arrow. dir is -1/0/1, y is the vertical anchor. */
function forceArrow(x, y, dir, colour) {
  if (!dir) return;
  ctx.fillStyle = colour;
  ctx.beginPath();
  const len = 13 * Math.abs(dir);
  ctx.moveTo(x, y);
  ctx.lineTo(x + dir * len, y - 5.5);
  ctx.lineTo(x + dir * len, y + 5.5);
  ctx.closePath();
  ctx.fill();
}

function render() {
  const groundY = viewH * 0.8;
  const midX = viewW / 2;
  const scale = viewW / (WORLD_HALF * 2);

  ctx.clearRect(0, 0, viewW, viewH);

  // track
  const trackHalf = px(X_THRESHOLD);
  ctx.fillStyle = '#151d29';
  ctx.fillRect(midX - trackHalf, groundY, trackHalf * 2, 6);
  ctx.fillStyle = '#1e2937';
  ctx.fillRect(midX - trackHalf - 24, groundY - 3, 24, 12);
  ctx.fillRect(midX + trackHalf, groundY - 3, 24, 12);

  const pivotX = midX + state.x * scale;
  const poleLenPx = px(1.0);
  const cartW = px(0.5);
  const cartH = 22;

  // failure-angle guides
  for (const dir of [-1, 1]) {
    const a = -Math.PI / 2 + dir * THETA_THRESHOLD;
    ctx.beginPath();
    ctx.moveTo(pivotX, groundY - cartH);
    ctx.lineTo(pivotX + Math.cos(a) * poleLenPx * 1.35, groundY - cartH + Math.sin(a) * poleLenPx * 1.35);
    ctx.strokeStyle = 'rgba(239,107,107,.20)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

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

  // ---- forces, drawn separately so a deadlock is visible -------------------
  const jevDir = jevAction === 1 ? 1 : -1;
  const youDir = Math.sign(humanForce());
  const edge = cartW / 2 + 3;

  if (settings.controlMode !== 'human') {
    forceArrow(pivotX + jevDir * edge, groundY - cartH * 0.68, jevDir, 'rgba(69,214,195,.9)');
  }
  if (settings.controlMode !== 'jev' && youDir) {
    forceArrow(pivotX + youDir * edge, groundY - cartH * 0.28, youDir, 'rgba(240,160,75,.95)');
  }

  // a cancelled push is the signature moment of versus mode -- call it out
  if (settings.controlMode === 'versus' && netForce === 0 && youDir) {
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(240,160,75,.95)';
    ctx.textAlign = 'center';
    ctx.fillText('forces cancelled — cart is coasting', pivotX, groundY - cartH - poleLenPx * 1.15);
    ctx.textAlign = 'left';
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

  // HUD
  ctx.font = '500 13px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#8593a6';
  ctx.fillText(`score ${score}`, 14, 24);
  ctx.fillText(`step ${score}/500`, 14, 44);
  const held = Math.round(1000 / settings.rate);
  ctx.fillText(`push held ${held} ms  (${held / (TAU * 1000)} physics steps)`, 14, 64);

  let line = 88;
  if (settings.controlMode !== 'human') {
    const jf = jevForce();
    ctx.fillStyle = '#45d6c3';
    ctx.fillText(`Jev  ${jf > 0 ? '→' : '←'} ${jf > 0 ? '+' : '−'}${Math.abs(jf)} N`, 14, line);
    line += 20;
  }
  if (settings.controlMode !== 'jev') {
    const hf = humanForce();
    ctx.fillStyle = hf === 0 ? '#5d6b7e' : '#f0a04b';
    ctx.fillText(`You  ${hf === 0 ? 'not pushing' : `${hf > 0 ? '→' : '←'} ${hf > 0 ? '+' : '−'}${Math.abs(hf)} N`}`, 14, line);
    line += 20;
  }
  if (settings.controlMode === 'versus') {
    ctx.fillStyle = netForce === 0 ? '#f0a04b' : '#8fa3ba';
    ctx.fillText(`net  ${netForce > 0 ? '+' : ''}${netForce} N  →  ${Math.abs(netForce / TOTAL_MASS_KG).toFixed(1)} m/s²`, 14, line);
    line += 20;
  }
  if (inFlight) {
    ctx.fillStyle = '#f0a04b';
    ctx.fillText('waiting for Jev…', 14, line);
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

/* ------------------------------------------------------------- scoreboards -- */

let lastStatsRender = 0;

function renderStats(now = 0) {
  if (now - lastStatsRender < 120) return;
  lastStatsRender = now;

  const avg = stats.decisions ? Math.round(stats.latencySum / stats.decisions) : 0;

  $('stats').innerHTML = `
    <dt>Current score</dt><dd class="${score > 200 ? 'good' : ''}">${score}</dd>
    <dt>Episodes</dt><dd>${boards.jev.episodes + boards.human.episodes + boards.versus.episodes}</dd>
    <dt>Decisions made</dt><dd>${stats.decisions}</dd>
    <dt>Decisions skipped</dt><dd class="${stats.skipped > stats.decisions ? 'warn' : ''}">${stats.skipped}</dd>
    <dt>Last latency</dt><dd>${stats.lastLatency ? `${stats.lastLatency} ms` : '—'}</dd>
    <dt>Mean latency</dt><dd>${avg ? `${avg} ms` : '—'}</dd>
    <dt>Tokens in / out</dt><dd>${stats.inputTokens} / ${stats.outputTokens}</dd>
    <dt>Spend so far</dt><dd>${money(stats.inputTokens)}</dd>
    <dt>Model reported</dt><dd>${esc(stats.modelSeen || '—')}</dd>
  `;

  const mean = (b) => (b.episodes ? (b.total / b.episodes).toFixed(0) : '—');
  const damage = boards.jev.episodes && boards.versus.episodes
    ? (boards.jev.total / boards.jev.episodes) - (boards.versus.total / boards.versus.episodes)
    : null;

  $('head2head').innerHTML = `
    <div class="stathead">Jev alone</div>
    <dt>Best</dt><dd class="jev">${boards.jev.best || '—'}</dd>
    <dt>Mean over ${boards.jev.episodes}</dt><dd class="jev">${mean(boards.jev)}</dd>

    <div class="stathead">You alone</div>
    <dt>Best</dt><dd class="you">${boards.human.best || '—'}</dd>
    <dt>Mean over ${boards.human.episodes}</dt><dd class="you">${mean(boards.human)}</dd>

    <div class="stathead">Contested</div>
    <dt>Jev vs you, best</dt><dd class="jev">${boards.versus.best || '—'}</dd>
    <dt>Jev vs you, mean</dt><dd class="jev">${mean(boards.versus)}</dd>
    <dt>Steps you cost it</dt><dd class="${damage !== null && damage > 0 ? 'you' : ''}">${damage === null ? '—' : damage.toFixed(0)}</dd>
  `;

  $('h2hIntro').innerHTML =
    boards.versus.episodes && boards.jev.episodes
      ? `Playing against you, Jev loses about <strong>${Math.max(0, damage ?? 0).toFixed(0)} steps</strong> per episode on average.`
      : 'Play a few episodes in each mode and the comparison fills in.';
}

/* ----------------------------------------------------------- state preview -- */

function currentHumanForce() {
  return settings.controlMode === 'jev' ? null : humanForce();
}

function statePreviewText() {
  return JSON.stringify(buildState(state, settings.representation, { humanForce: currentHumanForce() }), null, 2);
}

let lastPreview = 0;
function renderPreview(now = 0) {
  if (now - lastPreview < 100) return;
  lastPreview = now;
  $('statePreview').textContent = statePreviewText();

  const d = describeState(state);
  $('readout').innerHTML = [
    `x <b>${d.x.toFixed(3)}</b>`,
    `ẋ <b>${d.xDot.toFixed(3)}</b>`,
    `θ <b>${d.angleDeg.toFixed(2)}°</b>`,
    `θ̇ <b>${d.angleRateDeg.toFixed(1)}°/s</b>`,
  ].join('');
}

/* ----------------------------------------------------------------- episodes -- */

function startEpisode() {
  state = resetState();
  score = 0;
  trail = [];
  jevAction = 1;
  acc = 0;
  lastDecisionAt = 0;
  episodeMode = settings.controlMode;
  log('episode', `${MODES[episodeMode].label} — episode ${boards[episodeMode].episodes + 1} started`);
}

function endEpisode(reason) {
  const b = boards[episodeMode];
  b.episodes++;
  b.total += score;
  if (score > b.best) b.best = score;

  const cap = score >= MAX_STEPS ? ' (hit the 500-step cap)' : '';
  log('episode', `${MODES[episodeMode].label} episode ended after <span class="v-num">${score}</span> steps — ${reason}${cap}`);
  trail = [];

  if (settings.autorestart && running) {
    setTimeout(() => { if (running) startEpisode(); }, 400);
  } else {
    stop();
  }
}

/* ---------------------------------------------------------------- decisions -- */

function setStatus(s) { $('statusDot').dataset.state = s; }

async function decide() {
  inFlight = true;
  setStatus('thinking');

  const snapshot = { ...state };
  const snapshotHuman = humanForce();

  try {
    const out = await askJev({
      apiKey: $('apiKey').value.trim(),
      state: buildState(snapshot, settings.representation, {
        humanForce: settings.controlMode === 'jev' ? null : snapshotHuman,
      }),
      questions: QUESTIONS,
      model: $('model').value.trim() || DEFAULT_MODEL,
    });

    const decision = POLICIES[settings.policy].decide(out.answers, jevAction);
    jevAction = decision.action;

    stats.decisions++;
    stats.inputTokens += out.usage.input_tokens ?? 0;
    stats.outputTokens += out.usage.output_tokens ?? 0;
    stats.latencySum += out.latencyMs;
    stats.lastLatency = out.latencyMs;
    stats.modelSeen = out.model;

    const a = out.answers;
    const dir = decision.action === 1 ? 1 : -1;
    const vs = settings.controlMode === 'versus' && snapshotHuman !== 0
      ? ` <span class="v-dim">(you were ${snapshotHuman > 0 ? 'right' : 'left'})</span>`
      : '';

    log(
      'decision',
      `#${stats.decisions} Jev → ${dirSpan(dir, decision.action === 1 ? 'RIGHT' : 'LEFT')}` +
        ` <span class="k">p(right)</span>=<span class="v-num">${(a.push_right?.noul ?? NaN).toFixed(2)}</span>` +
        ` <span class="k">instab</span>=<span class="v-num">${(a.instability?.score ?? NaN).toFixed(1)}</span>` +
        ` <span class="v-dim">${out.latencyMs}ms in=${out.usage.input_tokens ?? 0}</span>${vs}`,
    );

    if (settings.verbose) log('raw', esc(JSON.stringify({ state: buildState(snapshot, settings.representation, { humanForce: snapshotHuman }), answers: a }, null, 1)));
  } catch (err) {
    stop();
    if (err instanceof BrowserBlockedError) {
      log('error', `<b>Could not reach the API.</b> ${esc(err.message)}`);
      log('warn', 'Start the app with <code>node tools/dev-proxy.mjs</code> and open <code>http://localhost:8787</code>.');
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

  if (running) {
    // ---- the whole versus mechanic, in two lines --------------------------
    const hf = settings.controlMode === 'jev' ? 0 : humanForce();
    const jf = jevForce();
    netForce = jf + hf;
    // ----------------------------------------------------------------------

    acc += dt * settings.simSpeed;
    while (acc >= TAU) {
      acc -= TAU;
      const r = stepForce(state, netForce);
      state = r.state;
      score += r.reward;
      if (r.terminated) { endEpisode('pole fell or cart left the track'); break; }
      if (score >= MAX_STEPS) { endEpisode('clean run'); break; }
    }

    if (settings.controlMode !== 'human') {
      const interval = 1000 / settings.rate;
      if (inFlight) {
        if (now - lastDecisionAt >= interval) stats.skipped++;
      } else if (now - lastDecisionAt >= interval) {
        lastDecisionAt = now;
        decide();
      }
    }
  }

  render();
  renderPreview(now);
  renderStats(now);
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- controls -- */

function start() {
  if (running) return;
  if (settings.controlMode !== 'human' && !$('apiKey').value.trim()) {
    log('warn', 'Enter your TypeSafe API key first.');
    return;
  }
  running = true;
  setStatus('running');
  $('btnStart').textContent = 'Pause';
  $('btnStart').dataset.running = 'true';
  startEpisode();
  const extra = settings.controlMode === 'human' ? ' (no API calls)' : ` at ${settings.rate} decisions/sec`;
  log('episode', `running — sim speed ${settings.simSpeed}×${extra}`);
}

function stop() {
  running = false;
  inFlight = false;
  setStatus('idle');
  $('btnStart').textContent = 'Start';
  $('btnStart').dataset.running = 'false';
}

function setMode(id) {
  if (!MODES[id] || settings.controlMode === id) return;
  const wasRunning = running;
  if (wasRunning) stop(); // never mix modes inside one episode's score
  settings.controlMode = id;
  persist();
  $('modeHint').textContent = MODES[id].hint;
  [...$('modeSeg').children].forEach((c) => c.setAttribute('aria-selected', String(c.dataset.mode === id)));
  log('episode', `mode → ${MODES[id].label}${wasRunning ? ' (stopped, scores stay separate)' : ''}`);
  if (wasRunning) log('warn', 'press Start to begin a fresh episode');
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

function holdButton(el, which) {
  const on = (e) => { e.preventDefault(); human[which] = true; el.classList.add('active'); };
  const off = () => { human[which] = false; el.classList.remove('active'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('pointercancel', off);
  // keyboard access on the button itself
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') on(e); });
  el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') off(); });
  el.addEventListener('blur', off);
}

function wire() {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('rate').value = settings.rate;
  $('rateOut').textContent = settings.rate;
  $('speed').value = settings.simSpeed;
  $('speedOut').textContent = `${settings.simSpeed}×`;
  $('autorestart').checked = settings.autorestart;
  $('verbose').checked = settings.verbose;

  $('apiKey').oninput = (e) => { settings.apiKey = e.target.value.trim(); persist(); };
  $('model').oninput = (e) => { settings.model = e.target.value.trim(); persist(); };
  $('rate').oninput = (e) => { settings.rate = +e.target.value; $('rateOut').textContent = settings.rate; persist(); };
  $('speed').oninput = (e) => { settings.simSpeed = +e.target.value; $('speedOut').textContent = `${settings.simSpeed}×`; persist(); };

  $('jevForce').value = settings.jevForceN;
  $('jevForceOut').textContent = `${settings.jevForceN} N`;
  $('humanForce').value = settings.humanForceN;
  $('humanForceOut').textContent = `${settings.humanForceN} N`;

  $('jevForce').oninput = (e) => {
    settings.jevForceN = +e.target.value;
    $('jevForceOut').textContent = `${settings.jevForceN} N`;
    persist();
  };
  $('humanForce').oninput = (e) => {
    settings.humanForceN = +e.target.value;
    $('humanForceOut').textContent = `${settings.humanForceN} N`;
    persist();
  };
  $('autorestart').onchange = (e) => { settings.autorestart = e.target.checked; persist(); };
  $('verbose').onchange = (e) => { settings.verbose = e.target.checked; persist(); };

  $('btnStart').onclick = () => (running ? stop() : start());
  $('btnReset').onclick = () => {
    stop();
    for (const k of Object.keys(boards)) Object.assign(boards[k], { episodes: 0, total: 0, best: 0 });
    Object.assign(stats, { decisions: 0, skipped: 0, inputTokens: 0, outputTokens: 0, latencySum: 0, lastLatency: 0 });
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
      if (err instanceof BrowserBlockedError) {
        log('error', `<b>Could not reach the API.</b> ${esc(err.message)}`);
      } else if (err instanceof ApiError) {
        log('error', `HTTP ${err.status} — ${esc(err.message)}`);
      } else {
        log('error', esc(err?.message ?? String(err)));
      }
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

  buildSegmented($('modeSeg'), MODES, settings.controlMode, setMode);
  $('modeHint').textContent = MODES[settings.controlMode].hint;

  holdButton($('pushLeft'), 'left');
  holdButton($('pushRight'), 'right');

  // keyboard: arrows or A/D, anywhere on the page
  const KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', a: 'left', A: 'left', d: 'right', D: 'right' };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.key];
    if (!k) return;
    const el = e.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    human[k] = true;
    $(k === 'left' ? 'pushLeft' : 'pushRight').classList.add('active');
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.key];
    if (!k) return;
    human[k] = false;
    $(k === 'left' ? 'pushLeft' : 'pushRight').classList.remove('active');
  });
  // never leave a key stuck down when focus or visibility changes
  const releaseAll = () => {
    human.left = human.right = false;
    $('pushLeft').classList.remove('active');
    $('pushRight').classList.remove('active');
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { releaseAll(); lastFrameAt = 0; });

  $('questionPreview').textContent = JSON.stringify(QUESTIONS, null, 2);
  $('questionCost').textContent =
    `${questionChars()} characters, re-sent on every single decision. The API has no caching, ` +
    `so this is ~91% of the per-frame cost — shortening it is the cheapest optimisation available.`;

  window.addEventListener('resize', fitCanvas);
}

/* -------------------------------------------------------------------- boot -- */

fitCanvas();
wire();
startEpisode();
render();
requestAnimationFrame(frame);
log('raw', 'ready. Pick a mode, set your API key and proxy URL, then press Start.');
log('raw', 'tip: switch to “You alone” to get a free personal baseline before paying for any API calls.');
