/**
 * CartPole x Jev.
 *
 * The shape of this program is the whole point:
 *
 *   - physics runs on a fixed 50 Hz timestep, in real time (scaled by sim speed)
 *   - QUESTIONS is built once and re-sent unchanged on every decision
 *   - only `state` differs between calls
 *   - several questions are asked per call (speculative fan-out); a policy
 *     decides in plain JavaScript which answer drives the cart
 *
 * Nothing about the questions changes at runtime. That is what makes a 10 Hz
 * control loop affordable: see the token counter in the scoreboard.
 */

import {
  step, resetState, MAX_STEPS, TAU, X_THRESHOLD, THETA_THRESHOLD, toDegrees, describeState,
} from './cartpole.js';
import { REPRESENTATIONS, buildState } from './state.js';
import { QUESTIONS, POLICIES, questionChars } from './questions.js';
import { askJev, testConnection, DEFAULT_MODEL, BrowserBlockedError, ApiError } from './typesafe.js';

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------- settings -- */

const LS_KEY = 'cartpole-jev-v1';

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { /* ignore */ }
  return {
    apiKey: '',
    proxyUrl: '',
    model: DEFAULT_MODEL,
    representation: 'prose',
    policy: 'threshold',
    rate: 10,
    simSpeed: 1,
    autorestart: true,
    verbose: false,
    ...saved,
  };
}

const settings = loadSettings();

function persist() {
  const { apiKey, proxyUrl, model, representation, policy, rate, simSpeed, autorestart, verbose } = settings;
  localStorage.setItem(LS_KEY, JSON.stringify({ apiKey, proxyUrl, model, representation, policy, rate, simSpeed, autorestart, verbose }));
}

/* ------------------------------------------------------------------ state -- */

let state = resetState();
let currentAction = 1;
let score = 0;
let running = false;
let inFlight = false;
let acc = 0;
let lastFrameAt = 0;
let lastDecisionAt = 0;
let trail = [];

const stats = {
  episodes: 0,
  best: 0,
  totalScore: 0,
  decisions: 0,
  skipped: 0,
  inputTokens: 0,
  outputTokens: 0,
  latencySum: 0,
  lastLatency: 0,
  modelSeen: '',
};

const PRICE_PER_MTOK_INPUT = 0.042; // USD, TypeSafe early access
const money = (tokens) => `$${((tokens * PRICE_PER_MTOK_INPUT) / 1e6).toFixed(5)}`;

/* ---------------------------------------------------------------- logging -- */

const logEl = $('log');
let logCount = 0;

function clockStamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

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

  // keep the DOM bounded during long runs
  if (++logCount > 500) { logEl.firstElementChild?.remove(); logCount--; }
  logEl.scrollTop = logEl.scrollHeight;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sideSpan = (v, text) => `<span class="${v >= 0 ? 'v-right' : 'v-left'}">${text}</span>`;

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

const WORLD_HALF = 3.1; // metres shown either side of centre
const polePx = (m) => (m / (WORLD_HALF * 2)) * viewW;

function render() {
  const groundY = viewH * 0.8;
  const midX = viewW / 2;
  const scale = viewW / (WORLD_HALF * 2);

  ctx.clearRect(0, 0, viewW, viewH);

  // track
  const trackHalf = polePx(X_THRESHOLD);
  ctx.fillStyle = '#151d29';
  ctx.fillRect(midX - trackHalf, groundY, trackHalf * 2, 6);
  ctx.fillStyle = '#1e2937';
  ctx.fillRect(midX - trackHalf - 24, groundY - 3, 24, 12);
  ctx.fillRect(midX + trackHalf, groundY - 3, 24, 12);

  // failure-angle guides, drawn as a faint cone from the pivot
  const cartX = state.x * scale;
  const pivotX = midX + cartX;
  const poleLenPx = 2 * 0.5 * scale;

  for (const dir of [-1, 1]) {
    const a = -Math.PI / 2 + dir * THETA_THRESHOLD;
    ctx.beginPath();
    ctx.moveTo(pivotX, groundY - 9);
    ctx.lineTo(pivotX + Math.cos(a) * poleLenPx * 1.35, groundY - 9 + Math.sin(a) * poleLenPx * 1.35);
    ctx.strokeStyle = 'rgba(239,107,107,.22)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // pole-tip trail
  if (trail.length > 1) {
    ctx.beginPath();
    trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(69,214,195,.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // cart
  const cartW = polePx(0.5), cartH = 22;
  ctx.fillStyle = '#243040';
  ctx.strokeStyle = '#33445a';
  ctx.lineWidth = 1;
  roundRect(ctx, pivotX - cartW / 2, groundY - cartH, cartW, cartH, 5);
  ctx.fill();
  ctx.stroke();

  // the push force indicator
  const forceDir = currentAction === 1 ? 1 : -1;
  ctx.fillStyle = currentAction === 1 ? 'rgba(90,169,240,.85)' : 'rgba(201,139,240,.85)';
  ctx.beginPath();
  const arrowY = groundY - cartH / 2;
  const ax = pivotX + forceDir * (cartW / 2 + 4);
  ctx.moveTo(ax, arrowY);
  ctx.lineTo(ax + forceDir * 14, arrowY - 6);
  ctx.lineTo(ax + forceDir * 14, arrowY + 6);
  ctx.closePath();
  ctx.fill();

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

  // pivot
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
  if (inFlight) {
    ctx.fillStyle = '#f0a04b';
    ctx.fillText('waiting for Jev…', 14, 64);
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

/* --------------------------------------------------------------- scoreboard -- */

let lastStatsRender = 0;

function renderStats(now = 0) {
  if (now - lastStatsRender < 120) return;
  lastStatsRender = now;

  const avg = stats.episodes ? stats.totalScore / stats.episodes : 0;
  const avgLatency = stats.decisions ? Math.round(stats.latencySum / stats.decisions) : 0;
  const achievedRate = running && stats.decisions ? (1000 / Math.max(1, lastDecisionAt ? now - lastDecisionAt : 1)).toFixed(1) : '—';

  $('stats').innerHTML = `
    <dt>Current score</dt><dd class="${score > 200 ? 'good' : ''}">${score}</dd>
    <dt>Best episode</dt><dd class="${stats.best >= 500 ? 'good' : ''}">${stats.best}</dd>
    <dt>Episodes</dt><dd>${stats.episodes}</dd>
    <dt>Average score</dt><dd>${avg.toFixed(1)}</dd>
    <dt>Decisions made</dt><dd>${stats.decisions}</dd>
    <dt>Decisions skipped</dt><dd class="${stats.skipped > stats.decisions ? 'warn' : ''}">${stats.skipped}</dd>
    <dt>Last latency</dt><dd>${stats.lastLatency ? `${stats.lastLatency} ms` : '—'}</dd>
    <dt>Mean latency</dt><dd>${avgLatency ? `${avgLatency} ms` : '—'}</dd>
    <dt>Tokens in / out</dt><dd>${stats.inputTokens} / ${stats.outputTokens}</dd>
    <dt>Spend so far</dt><dd>${money(stats.inputTokens)}</dd>
    <dt>Model reported</dt><dd>${esc(stats.modelSeen || '—')}</dd>
  `;
}

/* ------------------------------------------------------------- state preview -- */

function statePreviewText() {
  return JSON.stringify(buildState(state, settings.representation), null, 2);
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
    `limit ±${toDegrees(THETA_THRESHOLD).toFixed(0)}°`,
  ].join('');
}

/* ------------------------------------------------------------------ episodes -- */

function startEpisode() {
  state = resetState();
  score = 0;
  trail = [];
  currentAction = 1;
  acc = 0;
  lastDecisionAt = 0;
  log('episode', `episode ${stats.episodes + 1} started`);
}

function endEpisode(reason) {
  stats.episodes++;
  stats.totalScore += score;
  if (score > stats.best) stats.best = score;
  const capped = score >= MAX_STEPS ? ' (hit the 500-step cap)' : '';
  log('episode', `episode ${stats.episodes} ended after <span class="v-num">${score}</span> steps — ${reason}${capped}`);
  trail = [];

  if (settings.autorestart && running) {
    setTimeout(() => { if (running) startEpisode(); }, 400);
  } else {
    stop();
  }
}

/* ----------------------------------------------------------------- decisions -- */

function setStatus(s) { $('statusDot').dataset.state = s; }

async function decide() {
  inFlight = true;
  setStatus('thinking');

  // Snapshot the state at decision time. The answer will arrive after the cart
  // has already moved -- that actuation delay is real and part of what you see.
  const snapshot = { ...state };
  const payload = buildState(snapshot, settings.representation);

  try {
    const out = await askJev({
      baseUrl: $('proxyUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      state: payload,
      questions: QUESTIONS,
      model: $('model').value.trim() || DEFAULT_MODEL,
    });

    const policy = POLICIES[settings.policy];
    const decision = policy.decide(out.answers, currentAction);
    currentAction = decision.action;

    stats.decisions++;
    stats.inputTokens += out.usage.input_tokens ?? 0;
    stats.outputTokens += out.usage.output_tokens ?? 0;
    stats.latencySum += out.latencyMs;
    stats.lastLatency = out.latencyMs;
    stats.modelSeen = out.model;

    const a = out.answers;
    const arrow = decision.action === 1 ? 'RIGHT' : 'LEFT';
    const arrowSpan = sideSpan(decision.action === 1 ? 1 : -1, arrow);

    log(
      'decision',
      `#${stats.decisions} → ${arrowSpan}` +
        ` <span class="k">p(right)</span>=<span class="v-num">${(a.push_right?.noul ?? NaN).toFixed(2)}</span>` +
        ` <span class="k">choice</span>=<span class="v-num">${esc(a.direction?.choice ?? '—')}</span>` +
        ` <span class="k">instab</span>=<span class="v-num">${(a.instability?.score ?? NaN).toFixed(1)}</span>` +
        ` <span class="v-dim">${out.latencyMs}ms in=${out.usage.input_tokens ?? 0} out=${out.usage.output_tokens ?? 0}</span>` +
        ` <span class="v-dim">${esc(decision.note)}</span>`,
    );

    if (settings.verbose) {
      log('raw', esc(JSON.stringify({ state: payload, answers: a }, null, 1)));
    }
  } catch (err) {
    stop();
    if (err instanceof BrowserBlockedError) {
      log('error', `<b>Browser blocked the request.</b> ${esc(err.message)}`);
      log('warn', 'Deploy the Worker in <code>worker/</code> and paste its URL into “Proxy URL”. See README.');
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

/* -------------------------------------------------------------------- loop -- */

function frame(now) {
  const dt = Math.min((now - (lastFrameAt || now)) / 1000, 0.25);
  lastFrameAt = now;

  if (running) {
    acc += dt * settings.simSpeed;
    while (acc >= TAU) {
      acc -= TAU;
      const r = step(state, currentAction);
      state = r.state;
      score += r.reward;
      if (r.terminated) { endEpisode('pole fell or cart left the track'); break; }
      if (score >= MAX_STEPS) { endEpisode('clean run'); break; }
    }

    const interval = 1000 / settings.rate;
    if (inFlight) {
      if (now - lastDecisionAt >= interval) stats.skipped++;
    } else if (now - lastDecisionAt >= interval) {
      lastDecisionAt = now;
      decide();
    }
  }

  render();
  renderPreview(now);
  renderStats(now);
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- controls -- */

function start() {
  if (running) return;
  if (!$('apiKey').value.trim()) { log('warn', 'Enter your TypeSafe API key first.'); return; }
  if (!$('proxyUrl').value.trim()) { log('warn', 'Enter a proxy URL first (see README).'); return; }

  running = true;
  setStatus('running');
  $('btnStart').textContent = 'Pause';
  $('btnStart').dataset.running = 'true';
  if (score === 0 && stats.episodes === 0) startEpisode();
  log('episode', `running at ${settings.rate} decisions/sec, sim speed ${settings.simSpeed}×`);
}

function stop() {
  running = false;
  inFlight = false;
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
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === current));
    b.onclick = () => {
      onPick(id);
      [...container.children].forEach((c) => c.setAttribute('aria-selected', String(c === b)));
    };
    container.append(b);
  }
}

function wire() {
  // settings persisted to localStorage
  $('apiKey').value = settings.apiKey;
  $('proxyUrl').value = settings.proxyUrl;
  $('model').value = settings.model;
  $('rate').value = settings.rate;
  $('rateOut').textContent = settings.rate;
  $('speed').value = settings.simSpeed;
  $('speedOut').textContent = `${settings.simSpeed}×`;
  $('autorestart').checked = settings.autorestart;
  $('verbose').checked = settings.verbose;

  $('apiKey').oninput = (e) => { settings.apiKey = e.target.value.trim(); persist(); };
  $('proxyUrl').oninput = (e) => { settings.proxyUrl = e.target.value.trim(); persist(); };
  $('model').oninput = (e) => { settings.model = e.target.value.trim(); persist(); };

  $('rate').oninput = (e) => { settings.rate = +e.target.value; $('rateOut').textContent = settings.rate; persist(); };
  $('speed').oninput = (e) => {
    settings.simSpeed = +e.target.value;
    $('speedOut').textContent = `${settings.simSpeed}×`;
    persist();
  };
  $('autorestart').onchange = (e) => { settings.autorestart = e.target.checked; persist(); };
  $('verbose').onchange = (e) => { settings.verbose = e.target.checked; persist(); };

  $('btnStart').onclick = () => (running ? stop() : start());
  $('btnReset').onclick = () => { stop(); stats.episodes = 0; stats.best = 0; stats.totalScore = 0; stats.decisions = 0; stats.skipped = 0; stats.inputTokens = 0; stats.outputTokens = 0; stats.latencySum = 0; stats.lastLatency = 0; startEpisode(); log('episode', 'scoreboard reset'); };
  $('btnClearLog').onclick = () => { logEl.innerHTML = ''; logCount = 0; };

  $('btnForget').onclick = () => {
    settings.apiKey = '';
    $('apiKey').value = '';
    persist();
    log('warn', 'API key removed from this browser.');
  };

  $('btnTest').onclick = async () => {
    $('btnTest').disabled = true;
    log('raw', 'testing connection…');
    try {
      const out = await testConnection({
        baseUrl: $('proxyUrl').value.trim(),
        apiKey: $('apiKey').value.trim(),
        model: $('model').value.trim() || DEFAULT_MODEL,
      });
      log('episode', `connection OK — model <b>${esc(out.model)}</b>, ${out.latencyMs} ms, questions tokenised as ${out.usage.input_tokens} input tokens`);
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        log('error', `<b>Blocked before reaching TypeSafe.</b> ${esc(err.message)}`);
        log('warn', 'Deploy the Worker in <code>worker/</code> (takes a minute, free tier) and paste its URL in “Proxy URL”.');
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

  $('questionPreview').textContent = JSON.stringify(QUESTIONS, null, 2);
  $('questionCost').textContent =
    `This is ${questionChars()} characters and is re-sent on every single decision. ` +
    `The API has no caching, so shortening it directly cuts the cost per frame.`;

  $('proxyHint').innerHTML =
    'api.typesafe.ai rejects browser origins (verified: every origin gets <code>400 Disallowed CORS origin</code>), ' +
    'so a static page needs a pass-through. Deploy <code>worker/</code> and paste the URL here.';

  window.addEventListener('resize', fitCanvas);
  document.addEventListener('visibilitychange', () => { lastFrameAt = 0; });
}

/* -------------------------------------------------------------------- boot -- */

fitCanvas();
wire();
startEpisode();
render();
requestAnimationFrame(frame);
log('raw', 'ready. Set your API key and proxy URL, then press Start.');
