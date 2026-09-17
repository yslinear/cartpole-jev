# CartPole × Jev

Watch a decision model balance an inverted pendulum — and then try to knock it over yourself.

There is no reinforcement learning and no vision here. The app sends TypeSafe's
[Jev](https://docs.typesafe.ai) a **text description of the game state** plus a **fixed set of
questions**, gets back typed answers with probabilities, and turns one of them into a push.
Everything else — the physics, the control loop, the decision about which answer to trust —
is ordinary JavaScript you can read.

Three modes:

| | what happens |
|---|---|
| **Jev alone** | the model balances the pole. This is the baseline. |
| **You alone** | you push with ← / →. No API calls, so it is free — and it is your own baseline. |
| **Versus** | **both of you push the same cart at the same time, and the forces add.** |

---

## Quick start

```bash
node tools/dev-proxy.mjs
```

Open <http://localhost:8787>, paste your TypeSafe API key, press **Start**. That is the whole
setup — there is no proxy URL to configure, no dependencies, no build step. Node 18+ is all
you need.

---

## Versus mode: how the tug-of-war works

The cart has one force acting on it, and both players write into it:

```
net force = (Jev pushing right ? +10 N : −10 N) + (you holding a key ? ±10 N : 0)
```

| Jev | You | net | what you see |
|---|---|---|---|
| right | right | **+20 N** | a double push right |
| right | left | **0 N** | *forces cancelled — the cart coasts* |
| right | nothing | **+10 N** | Jev pushes alone |

With nobody touching the keys, the arithmetic degenerates exactly to the stock CartPole
action, so the verified physics below is unaffected. The app draws both force arrows
separately, and calls out the deadlock whenever your push cancels Jev's.

**Jev is told that you exist.** Its state includes a sentence like *"A person is fighting you
for this cart, and they are pushing it LEFT at 10 N"*, plus an explanation that the forces
add. Remove that sentence and the model has no way to know its pushes are being cancelled —
which is the single most interesting thing to experiment with here. It is also the reason the
state preview panel is worth watching while you play.

### An honest note about the game

A perfect counter-strategy exists: push the opposite way every time. That holds the net force
at 0 N, the cart coasts, and the pole falls under gravity alone. No balancer can defend
against it. The game is therefore not a fair fight at the top level of play — it is a
demonstration that **an adversary with equal authority over the same actuator can always
defeat the controller**, which is a real property of shared-actuator systems. What makes it
fun in practice is that a human cannot track Jev's direction changes at 10 Hz, so you are
always playing a few hundred milliseconds behind.

---

## Does Jev actually play?

CartPole's action is a constant 10 N push, not a proportional force. Holding any decision for
too many 20 ms steps overcorrects and destabilises the pole, so a **perfect hand-written
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

Past roughly 140 ms of held action, **nothing** can play this game. Any comparison that does
not give the baseline the same decision interval is meaningless.

Against a baseline held for the same interval (`node test/sweep.mjs --runs 2`):

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

**Deciding every single step, Jev scores a perfect 500 and exactly matches the hand-written
controller.** At a 5-step interval it collapses to 47 while the baseline still manages 263.
Jev's decisions are good enough to replace a hand-tuned rule when it can decide as often as it
wants, and it degrades faster than a purpose-built controller when decisions get expensive.

### The state representation matters, but the sample is small

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

Directionally: hiding magnitude from the model (`coarse`) hurts, and reading the **Noul**
beats reading the **Choice** here — the opposite of the intuitive pick. But the run-to-run
spread (47 to 191 for one configuration) is as large as the differences between
configurations. Treat these as a reason to run your own sweep, not as findings.

---

## Cost, and the one number worth knowing

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

At 10 decisions/second that is about **$1.11/hour, of which $1.01/hour is re-sending the same
questions.** Output tokens are free. If you want a cheap real-time loop, **shorten your
questions, not your state.**

---

## The physics is a faithful port

`src/cartpole.js` is ported from Gymnasium's `classic_control/cartpole.py`, and
`test/compare.mjs` runs both side by side for 400 steps:

```
  CartPole physics: JS vs Gymnasium
  control actions differing .. 0
  worst divergence .......... 9.61e-8 on thetaDot @ step 400
  tolerance ................. 1.00e-6
  PASS — identical decisions, trajectories agree to floating-point precision.
```

Two details that are easy to get wrong: Gymnasium's default integrator is **explicit** Euler
(`kinematics_integrator = "euler"`), not the semi-implicit variant; and the reset distribution
is `U(-0.05, 0.05)` over all four values.

The versus mode needed force-based stepping, so `stepForce(state, newtons)` was added and
`step(state, action)` now delegates to it. That refactor is checked too — over 4,432 steps
across 200 random trajectories, `stepForce(±10)` and `step(action)` are **bit-for-bit
identical**, so adding the human did not disturb the verified dynamics.

---

## Why there is no proxy URL in the UI

There used to be one, and there is a reason it went away.

`api.typesafe.ai` answers every browser origin with `400 Disallowed CORS origin` — verified
against `*.github.io`, `localhost:8080`, `localhost:5173`, `null`, `*` and even
`console.typesafe.ai`. So a page cannot call it directly.

But it does not follow that users should be pasting URLs. `tools/dev-proxy.mjs` serves the
page **and** the API route from one origin, so the app just calls the same-origin path
`/v1/systemone` and CORS never enters the picture. Hence `src/config.js`:

```js
export const API_BASE = '';   // '' = same origin
```

**Local use needs no configuration at all.** The one case that still needs something is a
host with no backend, like GitHub Pages — for that, deploy the included Worker, set
`API_BASE` to its URL, and that is the only line anyone has to touch.

```bash
cd worker && npx wrangler deploy     # prints https://typesafe-cors-proxy.you.workers.dev
```

The Worker is stateless, hard-codes the upstream host so it cannot become a general open
relay, and supports `ALLOWED_ORIGINS` and `PROXY_TOKEN` to lock it down.

### Deploying it

There are two supported shapes. Both need a Cloudflare account (free tier is enough); the DNS for
`yslinear.dev` is already on Cloudflare, so either is a couple of commands.

#### Shape 1 — Cloudflare Pages, same origin (recommended)

The page and the API route live on one origin, so `API_BASE` stays `''` and there is nothing to
configure. This is the same shape as local development.

```bash
npx wrangler login
npx wrangler pages deploy . --project-name cartpole-jev
```

`functions/v1/systemone.js` becomes the route `/v1/systemone` on that deployment. Test the
function before trusting it — that is how the `duplex: 'half'` bug in it was found:

```bash
node -e "import('./functions/v1/systemone.js').then(m => console.log(m.onRequestGet()))"
```

Serve it at a domain root (e.g. `cartpole.yslinear.dev`). A subpath deployment such as
`/cartpole-jev/` would move the route to `/cartpole-jev/v1/systemone` and break the relative call.

#### Shape 2 — Cloudflare Worker, keep GitHub Pages

The Worker below is stateless and hard-codes the upstream host, so it cannot become a general
open relay.

```bash
cd worker && npx wrangler deploy     # prints https://typesafe-cors-proxy.you.workers.dev
```

Then set that URL in `src/config.js` and rebuild. The call is cross-origin from here on, which is
fine: the Worker sends the CORS headers. Lock it down with `ALLOWED_ORIGINS` and `PROXY_TOKEN` in
`worker/wrangler.toml` if you care who uses it.

#### Why GitHub Pages alone can never work

GitHub Pages, and the `*.github.io` domain, are static hosts. Point the app at either one with
`API_BASE = ''` and the POST lands on the CDN instead of TypeSafe:

```
GET     https://yslinear.dev/v1/systemone  ->  404
OPTIONS https://yslinear.dev/v1/systemone  ->  405
POST    https://yslinear.dev/v1/systemone  ->  405   Method Not Allowed
```

That 405 is readable rather than a network error precisely because the call is same-origin, so no
CORS is involved — which is the point: same-origin is the right shape, it just needs something
to answer at that path. Switching to `yslinear.github.io` changes nothing (identical 405), and it
in fact 301-redirects back to the custom domain, because a user site's custom domain applies to
every project site beneath it.

### Security

- The API key is the user's own. It lives in that browser's `localStorage`, is sent to the
  API, and is never logged or written to disk. `src/app.js` never logs headers.
- If you point `API_BASE` at a proxy you operate, keys transit it. That is inherent to any
  CORS workaround. Self-host the Worker, or run locally, if that matters.
- `.gitignore` excludes `.env` files so a key can never be committed by accident.

---

## What the app lets you change

**How Jev sees the state** — three views of the same four numbers: `prose` (full sentences
with degrees), `raw` (bare JSON numbers), `coarse` (qualitative buckets, no numbers at all).
The live preview shows exactly what is being sent, including the opponent sentence when you
are in versus mode.

**Which answer drives the cart** — every question is always asked (speculative fan-out); the
policy only decides which answer to consume, at zero extra inference cost:

| | rule |
|---|---|
| `threshold` | push right if `P(right) > 0.5` |
| `gated` | only move when the margin is decisive, else hold |
| `choice` | use the Choice primitive and ignore the Noul |
| `composite` | blend the Noul with the instability Score in JavaScript |

**Plus** a live decision log with every latency, token count, probability and action; a
decision-rate slider; and a sim-speed slider, because when network latency makes real-time
control impossible, slowing the world down is the only honest workaround.

---

## Project structure

```
index.html               the page
src/config.js            the one line of configuration you might ever edit
src/cartpole.js          CartPole-v1 physics, plus the force-based step
src/state.js             state -> text, including the opponent sentence
src/questions.js         the fixed question set + the four policies
src/typesafe.js          API client with CORS-aware errors
src/app.js               the loop, the canvas, the force arithmetic, the log
worker/worker.js         optional Cloudflare Worker, only for static hosts
tools/dev-proxy.mjs      local dev: static server + API route on one origin
test/compare.mjs         physics regression vs Gymnasium
test/interval-limit.mjs  the environment's control-theoretic ceiling
test/token-split.mjs     where the per-frame tokens go
test/play-headless.mjs   headless episodes with fair baselines
test/versus-headless.mjs counter-strategies against Jev, with and without telling it
test/sweep.mjs           parameter sweep
```

## Testing

```bash
# physics vs the real Gymnasium
uv venv /tmp/cpenv --python 3.12
uv pip install --python /tmp/cpenv/bin/python gymnasium
PYTHON=/tmp/cpenv/bin/python node test/compare.mjs

node test/interval-limit.mjs      # no API calls
node tools/dev-proxy.mjs &        # the next few need this running
TYPESAFE_API_KEY=... node test/token-split.mjs
TYPESAFE_API_KEY=... node test/play-headless.mjs --episodes 3 --every 5
TYPESAFE_API_KEY=... node test/versus-headless.mjs --episodes 2
```

---

## License

The CartPole implementation derives from Gymnasium (Farama Foundation), BSD-3-Clause; the
equations originate in Barto, Sutton & Anderson (1983) via
[the 2005 cart-pole note](https://coneural.org/florian/papers/05_cart_pole.pdf).
