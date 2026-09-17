# CartPole × Jev

Watch a decision model balance an inverted pendulum, live, in your browser.

This is not reinforcement learning and there is no vision. The app sends TypeSafe's
[Jev](https://docs.typesafe.ai) a **text description of the game state** and a **fixed set of
questions**, gets back typed answers with probabilities, and turns one of them into a
left-or-right push. Everything else — the physics, the control loop, the decision of which
answer to trust — is ordinary JavaScript you can read.

The point is to make the shape of "AI as a programming primitive" concrete, and to show
honestly where it succeeds and where a five-line `if` statement beats it.

---

## Quick start (local, no deploy)

```bash
node tools/dev-proxy.mjs          # serves this folder and proxies the API
```

Then open <http://localhost:8787>, paste your TypeSafe API key, put
`http://localhost:8787` in the **Proxy URL** field, and press **Start**.

There are no dependencies to install. Node 18+ is enough.

---

## The CORS problem, and why you need a proxy

A static GitHub Pages site cannot call `api.typesafe.ai` directly. Every browser origin is
rejected on preflight. Measured, not guessed:

```bash
curl -i -X OPTIONS https://api.typesafe.ai/v1/systemone \
  -H "Origin: https://yslinear.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

```
HTTP/2 400
access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
access-control-allow-headers: Accept, ..., Authorization, ...
Disallowed CORS origin
```

That result is identical for `https://console.typesafe.ai`, `http://localhost:8080`,
`http://127.0.0.1:8000`, `null`, `*` and `*.github.io`. The server is behind an Istio/Envoy
CORS filter with an origin allowlist that does not include web pages. A real `POST` still
returns `200` — but without an `Access-Control-Allow-Origin` header, so the browser discards
the response.

The fix is a pass-through proxy. Two are included:

| | Use it for | Command |
|---|---|---|
| `tools/dev-proxy.mjs` | local development | `node tools/dev-proxy.mjs` |
| `worker/worker.js` | a deployed GitHub Pages site | see below |

---

## Deploying to GitHub Pages

### 1. Deploy the proxy (once, free)

The Worker is ~90 lines, stateless, and hard-codes the upstream host so it cannot be used
as a general-purpose open relay.

```bash
cd worker
npx wrangler deploy
```

Wrangler prints a URL like `https://typesafe-cors-proxy.<you>.workers.dev`. Open it in a
browser — you should see `{"ok":true,...}`.

To lock it down, edit `worker/wrangler.toml` and set `ALLOWED_ORIGINS` to your Pages
origin, e.g. `"https://yslinear.github.io"`. For an extra gate:

```bash
npx wrangler secret put PROXY_TOKEN
```

### 2. Turn on Pages

Push to `main`, then in **Settings → Pages** set the source to **GitHub Actions**. The
included workflow (`.github/workflows/deploy-pages.yml`) publishes the repo root. There is
no build step.

### 3. Tell users the URL

The app stores the proxy URL in `localStorage` per visitor. You can ship a default by
editing the `proxyUrl` initial value in `src/app.js`.

---

## Security: read this before hosting a public instance

- **The API key is the user's own.** It is typed into the page, kept in that browser's
  `localStorage`, sent to your proxy, and forwarded to `api.typesafe.ai`. It is never
  written to disk, logged, or stored by either proxy.
- **The key does transit your proxy.** Whoever operates it can, in principle, observe
  keys in flight. That is inherent to any CORS workaround. If that is unacceptable,
  self-host the Worker, or run `tools/dev-proxy.mjs` locally so the key never leaves
  the machine.
- **A public proxy is an open relay** for anyone with their own valid key. It cannot leak
  your credentials, but it can consume your Cloudflare quota. Set `ALLOWED_ORIGINS` and/or
  `PROXY_TOKEN` if you care.
- Deploying the proxy on someone else's behalf means their keys pass through your Worker.
  Say so plainly in your own README.

---

## Cost

Measured on real requests (`node test/token-split.mjs`):

| payload | input tokens |
|---|---|
| the fixed question set alone | **670** |
| + prose state | 734 (+64) |
| + raw JSON state | 718 (+48) |
| + coarse state | 701 (+31) |

TypeSafe has **no prompt caching** — the request body is just `state`, `model`, `questions`,
and all three are re-sent every call. So **91% of every frame is the question set**, not the
game state.

At 10 decisions/second that is about **$1.11/hour, of which $1.01/hour is re-sending the
same questions**. Output tokens are free.

This is the single most actionable finding in the repo: if you want a cheap real-time loop,
**shorten your questions**, not your state. A CartPole episode at 5 steps/decision costs
roughly $0.0003.

---

## Findings

### The physics is a faithful port

`src/cartpole.js` is ported from Gymnasium's `classic_control/cartpole.py`. `test/compare.mjs`
runs both side by side for 400 steps and asserts identical control decisions:

```
  CartPole physics: JS vs Gymnasium
  samples compared .......... 20
  control actions differing .. 0
  worst divergence .......... 9.61e-8 on thetaDot @ step 400
  tolerance ................. 1.00e-6
  PASS — identical decisions, trajectories agree to floating-point precision.
```

Default Gymnasium uses **explicit** Euler (`kinematics_integrator = "euler"`), not the
semi-implicit variant, and the reset distribution is `U(-0.05, 0.05)` over all four
values. Both are replicated.

### Does Jev actually play?

Yes, but the interesting part is *when* it stops working, and why the obvious
comparison is unfair.

CartPole's action is a constant 10 N push, not a proportional force. Holding any decision for
too many 20 ms steps overcorrects and destabilises the pole. A **perfect hand-written
controller** degrades like this (`node test/interval-limit.mjs`):

```
   N    hold time    score  ended
   1      20 ms       500  cap     ████████████████████
   2      40 ms       500  cap     ████████████████████
   3      60 ms       500  cap     ████████████████████
   4      80 ms       500  cap     ████████████████████
   5     100 ms       263  fell    ███████████·········
   6     120 ms        61  fell    ██··················
   7     140 ms        11  fell    ····················
  10     200 ms        10  fell    ····················
```

So a fair test compares Jev against a baseline **held for the same interval**. Measured
(`node test/sweep.mjs --runs 2`, single fixed start state):

```
  configuration                       mean  best  worst  caps   tok/episode      cost
  random, held 1 step                   17    20     14   0/2             0  $0.00000
  PD heuristic, held 1 step            500   500    500   2/2             0  $0.00000
  Jev prose/threshold, every 1 step    500   500    500   2/2       369,664  $0.01553

  PD heuristic, held 5 steps           263   263    263   0/2             0  $0.00000
  Jev prose/threshold, every 5 steps    47    47     47   0/2         7,434  $0.00031

  PD heuristic, held 10 steps           10    10     10   0/2             0  $0.00000
  Jev prose/threshold, every 10 steps   10    10     10   0/2           734  $0.00003
```

**At a decision every step, Jev scores a perfect 500/500 and exactly matches the
hand-written controller.** At a 5-step interval it collapses to 47 while the baseline still
manages 263. Past ~140 ms of held action, *nothing* can play — both score 10 — so those rows
say nothing about Jev either way.

The honest conclusion: Jev's decisions are good enough to replace a hand-tuned rule **when
it can decide as often as it wants**, and it degrades faster than a purpose-built controller
when decisions get expensive. That is a sensible place for a general model to land, and it
is the opposite of the Doom demo's framing.

### The state representation and the policy both matter, but the sample is small

At a 5-step interval, where everyone is struggling, 2 runs per configuration:

```
  representation        policy          mean   best   worst
  prose                 threshold         47     47      47
  raw JSON              threshold         43     43      43
  coarse (no numbers)   threshold         23     23      23

  prose                 threshold        119    191      47
  prose                 gated             23     23      23
  prose                 choice            47     47      47
  prose                 composite        119    191      47
```

Two weak signals, not conclusions — the run-to-run spread (47 to 191 for the same
configuration) is as large as the differences between configurations. Directionally: hiding
magnitude from the model (`coarse`) hurts, and reading the **Noul** beats reading the
**Choice** here, which is the opposite of the intuitive choice. Treat these as a reason to
run your own sweep, not as findings.

Run it yourself:

```bash
node tools/dev-proxy.mjs &
TYPESAFE_API_KEY=... node test/sweep.mjs --runs 3
```

---

## What the app lets you change

The interface is built so you can feel the design surface, not just watch a demo.

**How Jev sees the state** — three representations of the same four numbers:

| | what it sends | why it matters |
|---|---|---|
| `prose` | full sentences with degrees, one per physical quantity | closest to how a human would describe it |
| `raw` | bare JSON numbers, no interpretation | lets the model do its own arithmetic |
| `coarse` | qualitative buckets only, no numbers | shortest, but throws away magnitude |

**Which answer drives the cart** — every question is always asked (speculative fan-out);
the policy only decides which answer to consume, at zero extra inference cost:

| | rule |
|---|---|
| `threshold` | push right if `P(right) > 0.5` |
| `gated` | only move when the margin is decisive, else hold the previous action |
| `choice` | use the Choice primitive and ignore the Noul |
| `composite` | blend the Noul with the instability Score in JavaScript |

**Plus** a live decision log showing every latency, token count, probability and action; a
decision-rate slider; and a sim-speed slider so you can slow the world down when network
latency makes real-time control impossible.

---

## Project structure

```
index.html               the page
src/cartpole.js          Gymnasium CartPole-v1 physics (no dependencies)
src/state.js             state -> text. The actual design surface.
src/questions.js         the fixed question set + the policies that consume answers
src/typesafe.js          API client with CORS-aware error messages
src/app.js               the loop, the canvas, the log
worker/worker.js         Cloudflare Worker CORS pass-through
tools/dev-proxy.mjs      local dev: static server + proxy, zero dependencies
test/compare.mjs         physics regression test vs Gymnasium
test/play-headless.mjs   headless episodes with fair baselines
test/sweep.mjs           parameter sweep
test/token-split.mjs     where the per-frame tokens go
```

## Testing

```bash
# physics vs the real Gymnasium (needs gymnasium in a venv)
uv venv /tmp/cpenv --python 3.12
uv pip install --python /tmp/cpenv/bin/python gymnasium
PYTHON=/tmp/cpenv/bin/python node test/compare.mjs

# token accounting
node tools/dev-proxy.mjs &
node test/token-split.mjs

# episodes with baselines
TYPESAFE_API_KEY=... node test/play-headless.mjs --episodes 3 --every 5
```

---

## License

The CartPole port derives from Gymnasium (Farama Foundation), BSD-3-Clause; the equations
originate in Barto, Sutton & Anderson (1983) via
[the 2005 cart-pole note](https://coneural.org/florian/papers/05_cart_pole.pdf).
Everything else here is yours to do what you like with.
