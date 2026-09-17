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

Two ways to run it locally. Neither needs a build step or any dependency.

**With wrangler** — the real Workers runtime, byte-identical to production:

```bash
npx wrangler pages dev public --port 8787
```

**Without wrangler** — a dependency-free Node server that does the same thing:

```bash
node tools/dev-proxy.mjs
```

Either way, open <http://localhost:8787>, paste your TypeSafe API key, press **Start**. There is
no proxy URL to configure: the page and the API route share one origin, so
`API_BASE = ''` just works. Node 18+ is all you need.

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

Cost is then just frame size × decision rate. Measured on real episodes at the shipped
defaults (4 N, 25 decisions/sec):

| configuration | score | decisions/episode | tokens/episode | cost |
|---|---|---|---|---|
| 10 N, 10/sec *(the old default)* | 42 | 9 | 6,746 | $0.0003 |
| 4 N, 25/sec *(shipped)*, single episode | 500 | 250 | 186,544 | $0.0078 |
| 10 N, 50/sec, single episode | 500 | 500 | 373,595 | $0.0157 |

Single episodes flatter any of these, so here is a five-episode sample at the shipped
defaults, which is the number worth trusting:

```
  ep 1: score 232 (fell)   peak pole angle 12.1°
  ep 2: score 500 (cap)    peak pole angle  2.5°
  ep 3: score 434 (fell)   peak pole angle 12.5°
  ep 4: score 500 (cap)    peak pole angle  2.4°
  ep 5: score 500 (cap)    peak pole angle  2.6°

  mean 433   best 500   worst 232   balanced 3/5   mean cost $0.0068 per episode
```

It balances three times in five and averages 433. That failure rate is deliberate for this
demo: a controller that never loses cannot be knocked over, and then the shove has nothing to
prove. Note the shape of the failures — every episode that survived stayed inside 2.6°, every
one that died ran to the 12° limit. That gap is the signature of a controller that is really
controlling versus one that has lost the pole.

At 10 decisions/second the old default worked out to about **$1.11/hour, of which $1.01/hour
was re-sending the same questions** — and it could not balance at any force. Output tokens are
free. If you want a cheap real-time loop, **shorten your questions, not your state**, and then
pick the lowest decision rate that still balances.

### The force and the decision rate are not independent

This is the finding that took the longest to see, because the standard CartPole value is a red
herring. Gymnasium applies an action **every physics step** — 50 times a second. This app holds
each decision for a whole interval, so at 10 decisions/sec every push lasts 100 ms, and
`test/interval-limit.mjs` had already shown that even a **perfect** controller collapses when
forced to hold that long.

`test/force-rate.mjs` sweeps the two against each other with real calls:

| setup | score | peak pole angle |
|---|---|---|
| 10 N, 10/sec | 42 | 12.7° |
| 6 N, 10/sec | 188 | 12.6° |
| 4 N, 10/sec | 68 | 12.8° |
| 10 N, 25/sec | 235 | 13.0° |
| 4 N, 25/sec | **500** | **2.5°** |
| 10 N, 50/sec | **500** | **2.1°** |
| 3 N, 50/sec | **500** | **0.8°** |

**At 10 decisions/sec no force balances.** The rows that succeed hold the pole inside ~2.5°;
the ones that fail all run to the 12° limit, which is the signature of a controller that is
chasing rather than controlling. So when the cart twitches and the pole slowly wanders away,
the cause is the hold time, not the strength of the push.

Worth saying plainly: `test/control-quality.mjs` checked whether the twitching was bad
judgement, and it is not. Jev's decisions agree with a hand-written PD controller **92% of the
time** (and with a naive angle-only rule only 64% — it does account for angular velocity). A
high rate of direction changes is normal here, because an oscillating pole needs an alternating
command.

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

## Why an API route exists at all

The app asks you for your own key and sends it straight to TypeSafe. That would be a pure
static site, except `api.typesafe.ai` refuses to be called from a browser at all. Measured,
against every origin I could think of:

```
Origin: https://cartpole-jev.pages.dev   ->  400 Disallowed CORS origin
Origin: https://yslinear.dev             ->  400
Origin: http://localhost:8080            ->  400
Origin: https://console.typesafe.ai      ->  400   (their own console!)
Origin: null  |  Origin: *               ->  400
```

Two requirements each force a preflight on their own:

- `Authorization: Bearer …` is not a CORS-safelisted header.
- `Content-Type: application/json` is not a safelisted value.

The preflight is rejected, so the browser never sends the real request. Even the response that
*does* come back from a non-browser client omits `Access-Control-Allow-Origin`, so a browser
would discard it anyway.

The ways around it do not work either:

| approach | result |
|---|---|
| `Content-Type: text/plain` (safelisted, no preflight) | reaches the server, but FastAPI reads the body as a raw **string**: `Input should be a valid dictionary or object` |
| key in a query parameter | not supported; the API documents the `Authorization` header only |
| `fetch(..., { mode: 'no-cors' })` | sends, but the response is opaque — unreadable, so useless |
| a WebSocket (not subject to CORS) | TypeSafe has no WebSocket endpoint |

So the page needs a route on its own origin, and `functions/v1/systemone.js` is it: ~40 lines,
stateless, forwarding the key it is given and never logging it. Pointing `API_BASE` straight at
`https://api.typesafe.ai` would, if TypeSafe ever allows a browser origin, delete that file
entirely — it is the only thing standing between this and a pure static site, and it is their
configuration to change, not this project's.

### Keys, and where they go

- The key is yours. It lives in that browser's `localStorage`, goes to the API, and is never
  logged or written to disk — `src/app.js` never touches headers.
- If `API_BASE` points at someone else's route, your key transits it. That is inherent to any
  CORS workaround. Running locally, or self-hosting, avoids it.

### One verification gotcha

Unmatched paths return the app with `200`, not a 404, so a status code alone proves nothing here:
`/.git/config` answers `200` with `index.html`, not a config file. Read the body, and check a
deleted file with `?cb=<time>` — a cache hit and a real file look identical otherwise.

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
control impossible, the physics has to be slowed to match.

---

## How much room does the pole need?

CartPole ends the episode at 12° of lean. That is a tight budget, and once decisions are
spaced out it is the binding constraint rather than the controller. The limit is now a setting —
physics untouched, only where a run is called over — and the model is told the real figure in
its state, so it does not bail out of situations it could still save.

A hand-written PD controller, force 4 N, no model error at all, over the same start state:

| give-up angle | score at 160 ms hold | score at 240 ms hold |
|---|---|---|
| ±12° | 72 *(peak 12.1° — hit the wall)* | 14 |
| **±20°** | 373 *(peak 9.2° — never came close)* | 23 |
| **±30°** | **428** | 34 |
| ±45° | 249 | 40 |
| ±60° | 190 | 58 |

Two different things are going on, and telling them apart matters.

At a **160 ms** hold, a wider limit genuinely helps: 72 becomes 428, and the peak angle stays
well inside the new boundary, which means the controller is recovering rather than surviving.
The 12° row is the odd one out — its peak *equals* its limit, so it failed immediately.

At a **240 ms** hold, a wider limit only delays the fall. Look at the peaks: 12.7°, 20.7°,
30.6°, 45.7°, 60.6° — every one runs all the way to its boundary. The score rises with the
limit because there is further to fall, not because anything is under control.

And wider is not monotonically better. 45° and 60° score worse than 20° and 30° even at 160 ms:
a pole that far over is harder to bring back, so the extra room costs more than it buys. The
useful range is roughly 20–30°, which is why the app starts at 20°.

The model gets less out of this than the PD rule does, and the difference is worth stating
plainly. Same conditions, but Jev deciding through the API instead of a PD rule:

| give-up angle | PD rule | Jev |
|---|---|---|
| ±12° | 72 *(peak 12.1°)* | 36 *(peak 12.7°)* |
| ±20° | 373 *(peak 9.2°)* | 81 *(peak 22.0°)* |
| ±30° | 428 *(peak 11.3°)* | 55 *(peak 30.5°)* |

Jev does improve, roughly 2.2x. But read the peaks: 12.7°, 22.0°, 30.5° — each one runs to its
own boundary, exactly the pattern that means a controller is not actually in control. The PD
rule at ±20° peaking at 9.2° is the opposite: it used the extra room to recover. So a wider give-
up angle buys Jev more time, not more competence, at this decision interval.

```bash
node test/interval-limit.mjs      # the same idea for hold time, no API calls
```

---

## Can Jev decide how hard to push?

Yes, and it is the difference between bang-bang control and something closer to proportional.

The controller used to pick only a direction and push with a fixed force. `interval-limit.mjs`
shows why that is fragile: a constant force held across a long decision interval always
overshoots. So there is now a second question — `push_right` (Noul) gives the direction and
`push_force` (Score) gives the magnitude, and code multiplies them. Only the force changes;
everything else is identical.

`test/force-grading.mjs`, real calls, 1 episode per row, base force 4 N:

| decision interval | fixed force | model chooses force |
|---|---|---|
| 40 ms (2 steps) | 423, peak 12.1° | **500, balanced**, peak **1.4°** |
| 100 ms (5 steps) | 367 | 103 |
| 200 ms (10 steps) | 20 | 93 |
| 400 ms (20 steps) | 15 | 33 |

At 40 ms the model used **1.0 N on average**, varying over 1.2 N — it taught itself to push
gently when the pole was nearly upright. The fixed policy cannot do that: it pushes just as
hard at 0.5° of lean as at 10°, which is precisely what overshoots. The peak angle tells the
story better than the score: 1.4° versus 12.1° is the difference between controlling the pole
and chasing it.

It is not a free win. At 100 ms the graded policy did **worse** (103 versus 367), and one
sample per row is not enough to call that. The plausible reading is that a coarse interval
needs a decisive push rather than a proportionate one, and a policy that starts gentle is too
slow to correct. It also costs real money: the extra question adds about 137 input tokens per
call, which shows up as 230k tokens against 196k over the same 250 decisions.

So: the model can assess force, it clearly helps when decisions are frequent, and it does not
rescue a coarse interval. Anyone reading this should run their own sweep —
`node test/force-grading.mjs --episodes 3` — before quoting these numbers.

---

## Project structure

```
public/index.html        the page
public/src/config.js     the one line of configuration you might ever edit
public/src/cartpole.js   CartPole-v1 physics, plus the force-based step
public/src/state.js      state -> text (three representations)
public/src/questions.js  the fixed question set + the four policies
public/src/typesafe.js   API client with CORS-aware errors
public/src/app.js        the loop, the canvas, the shove, the log
functions/v1/systemone   the Pages Function that makes /v1/systemone exist
tools/dev-proxy.mjs      local dev without wrangler: static + API on one origin

test/compare.mjs         physics regression vs Gymnasium
test/interval-limit.mjs  the environment's control-theoretic ceiling
test/force-rate.mjs      force vs decision rate, with real calls
test/control-quality.mjs is the twitching bad judgement, or just dithering?
test/token-split.mjs     where the per-frame tokens go
test/play-headless.mjs   headless episodes with fair baselines
test/smoke-dom.mjs       imports the real app.js against a stub DOM
test/sweep.mjs           parameter sweep
```

Only `public/` is the site. Everything else — the harnesses, the dev server, this file — sits
beside it and is never served.

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
