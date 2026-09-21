# CartPole × Jev

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An inverted pendulum as an instrument for looking closely at **Jev**, TypeSafe's decision model:
what it is good at, where it stops being good, and how much of the outcome is actually down to
it rather than to how the problem was framed.

Jev keeps the pole up. You click either side of the cart to shove it and see whether it recovers.

---

## What Jev is, and is not

Worth being precise, because most intuitions carried over from chat models are wrong here.

| | |
|---|---|
| **Input** | one `state` (a string, or structured JSON) and a map of typed questions |
| **Output** | one typed answer per question, with probabilities — never prose |
| **Primitives** | Noul (probability of yes), Choice (one of a set, plus the full distribution), Score (probability-weighted position on ordered levels) |
| **Not** | a chat model. There is nothing to converse with; you cannot ask it why |
| **Not** | multimodal. It receives text, and in this project it never sees a pixel |
| **Not** | stateful. Every call is independent — it has no memory of the previous frame |
| **Is** | fast (70–500 ms end to end) and cheap (output tokens are free) |

The last two points shape everything below. A controller normally acts on a history — error,
derivative, integral. Jev gets a snapshot, once per call, and must answer from that alone.

`src/questions.js` is the entire vocabulary it ever sees. Five questions, always the same five:

```
push_right    Noul   "should YOU push the cart to the RIGHT on this step?"
direction     Choice push_left / push_right
falling_right Noul   is the pole rotating rightwards
instability   Score  stable / drifting / off balance / critical
push_force    Score  feather / moderate / firm / maximum
```

Every answer is fetched on every call regardless of whether the policy consumes it — questions are
evaluated in parallel and adding one barely changes latency. `src/questions.js` also holds the five
policies that decide which answer drives the cart; see **The direction is easy** below.

---

## What it turned out to be good at

### Its judgement is close to a hand-written controller's

The obvious worry with a model in a control loop is that it makes bad decisions. It does not.
`test/control-quality.mjs` compares every decision against the PD rule a person would write
(`push right if theta + 0.2 * thetaDot > 0`):

```
agrees with PD (theta + 0.2*thetaDot):  49 / 53   (92%)
agrees with angle-sign only ..........  34 / 53   (64%)
```

Two things worth taking from that. It agrees with a competent rule 92% of the time, and it agrees
with a *naive* rule only 64% — so it is genuinely using the angular velocity, not just reacting to
which way the pole leans. A controller that only looks at the angle oscillates.

The consequence is that a high rate of direction changes is not a fault. An oscillating pole needs
an alternating command, and the PD rule flips just as often.

### It can decide how hard to push, and it pushes gently

The controller used to be bang-bang: a direction, and a force fixed by a slider. `push_force` was
added so the model chooses the magnitude too, and the policy multiplies direction by magnitude.

At a 40 ms decision interval it used **1.0 N on average**, varying over 1.2 N, against a fixed 4 N.
It taught itself to push gently when the pole was already nearly upright, which is what a
proportional controller does:

| decision interval | fixed 4 N | model chooses force |
|---|---|---|
| 40 ms | 423, peak **12.1°** | **500, balanced**, peak **1.4°** |
| 100 ms | 367 | 103 |
| 200 ms | 20 | 93 |
| 400 ms | 15 | 33 |

The peak angle says more than the score: 1.4° against 12.1° is the difference between controlling
the pole and chasing it.

---

## Where it stops being good

### A wide give-up angle buys it time, not competence

Episodes end at a set lean. CartPole's own value is 12°, which is a tight budget, so it is now a
setting. A hand-written PD rule uses the extra room properly; Jev does not:

| give-up angle | PD rule | Jev |
|---|---|---|
| ±12° | 72 *(peak 12.1° — hit the wall)* | 36 *(peak 12.7°)* |
| ±20° | **373** *(peak **9.2°** — never came close)* | 81 *(peak 22.0°)* |
| ±30° | 428 *(peak 11.3°)* | 55 *(peak 30.5°)* |

Jev improves about 2.2x, which is real. But every one of its peaks lands on its own boundary:
12.7°, 22.0°, 30.5°. That pattern means the pole is running to the wall rather than being brought
back. The PD rule peaking at 9.2° inside a 20° budget is the opposite. A wider angle gives the
model longer before it loses, not a better grip.

Wider is not monotonically better either: 45° and 60° score *worse* than 20° and 30°, because a pole
that far over is harder to recover. The useful range is roughly 20–30°.

### Its decisions are not enough on their own

It has no memory, so it cannot integrate error the way a normal controller does. It compensates by
answering often — but "often" costs a round trip. Measured at a 160 ms hold with force fixed, Jev
loses the pole while a PD rule holds it, and the reason is that the PD rule is acting between Jev's
calls.

That is the central honest finding of the project: **Jev's judgement matched a hand-written rule
92% of the time and still lost, because the timing of when it gets to judge is as decisive as the
judgement.** Two independent measurements show it:

```
decision interval   fixed force      model chooses force
40 ms               423              500 balanced
100 ms              367              103
200 ms               20               93
400 ms               15               33
```

At 100 ms the graded policy did *worse* than the fixed one — one sample, so not a conclusion, but
the plausible reading is that a coarse interval needs a decisive push rather than a proportionate
one, and a policy that starts gentle is too slow to correct.

### Framing matters as much as the answers

The same four numbers, rendered three ways, produce different outcomes. `coarse` strips magnitude
and reports qualitative buckets; the model then has nothing to reason with. It is the clearest
demonstration in the project that the answers are only as good as the question.

| representation | what it sends |
|---|---|
| `prose` | full sentences with degrees, one per quantity |
| `raw` | bare JSON numbers, no interpretation |
| `coarse` | qualitative buckets, no numbers at all |

The state also tells the model how much of the give-up budget is left, because a model that assumes
12° will abandon recoverable situations when the limit is 30°.

---

## What it costs

Measured on real requests (`test/token-split.mjs`):

| payload | input tokens |
|---|---|
| the fixed question set alone | **855** |
| + prose state | 921 (+66) |
| + raw state | 903 (+48) |
| + coarse state | 886 (+31) |

The API has **no prompt caching** — `state`, `model` and `questions` are re-sent on every call — so
**93% of every frame is the question set**, not the game state. Output tokens are free. Asking Jev
to choose its own force is why the set is 855 rather than the 670 measured before `push_force`
existed: one more Score question costs about 185 tokens on every single call, forever.

Cost is simply frame size × decision rate, which is why the decision rate is the knob that matters.
A decision costs **931 tokens** at the shipped settings, measured over real episodes:

| configuration | score | decisions/episode | tokens/episode | cost |
|---|---|---|---|---|
| 4 N, 25/sec | 500 | 250 | ~233,000 | $0.0098 |
| 10 N, every step | 500 | 500 | ~466,000 | $0.0196 |

At 25 decisions/second that is about **$3.52/hour**, of which roughly $3.27 is re-sending the same
five questions for every decision.

Three episodes at the shipped defaults (4 N, 25/sec, 20° limit), which is the honest picture:
**342, 500, 391** — mean 411, held to the cap once. An earlier five-episode sample at a 12° limit
and a four-question set gave mean 433, held 3 of 5. Both land around 400: it balances perhaps half
the time and averages about 400, and the episodes it loses peak at 20–22°, meaning it runs to the
boundary rather than being caught out early.

That failure rate is deliberate. A controller that never loses cannot be shoved over, and then the
shove proves nothing.

**If you want a cheaper loop, shorten the questions, not the state.**

---

## Running it

```bash
npx wrangler pages dev public --port 8787    # the real Workers runtime
# or, with no dependencies at all:
node tools/dev-proxy.mjs
```

Open <http://localhost:8787>, paste a TypeSafe API key, press Start. Your key stays in the browser,
goes only to TypeSafe, and is never logged.

**Click either side of the cart to shove it.** Arrow keys do the same. A shove is an impulse, so it
cannot be predicted — only its effect is visible, in the velocities Jev receives. Each shove is
scored as recovered or fatal: survived if the episode lasts another half second.

Settings worth knowing:

- **Decisions / sec** is a request, not a guarantee. A call takes a few hundred milliseconds, so the
  browser cannot honour 25/sec.
- **Match speed to API latency** is on by default, and it is what makes the demo work: the world is
  slowed until one decision covers about 40 ms of it. Turn it off to run in real time and watch a
  *perfect* controller score 16 — see `test/latency-reality.mjs`.
- **Give up at** is the lean limit, 8° to 60°.
- **Representation** and **policy** are the two design surfaces.

---

## Files

```
public/index.html        the page
public/src/cartpole.js   CartPole-v1 physics, plus force-based stepping
public/src/state.js      state -> text, three representations
public/src/questions.js  the four questions, and the five policies
public/src/typesafe.js   API client
public/src/app.js        the loop, the canvas, the shove, the log
functions/               the API route; TypeSafe's CORS policy makes one necessary

test/compare.mjs         physics regression against the real Gymnasium
test/interval-limit.mjs  how long a perfect controller can hold a decision
test/latency-reality.mjs why the world has to be slowed down
test/control-quality.mjs is the twitching bad judgement, or just oscillation?
test/force-grading.mjs   fixed force against model-chosen force
test/force-rate.mjs      force against decision rate
test/token-split.mjs     where the per-frame tokens go
test/loop-integrity.mjs  episode bookkeeping and HUD layout, against a stub DOM
test/smoke-dom.mjs       does app.js import and render without throwing
```

## Testing

```bash
node test/smoke-dom.mjs && node test/loop-integrity.mjs   # no API calls
node test/interval-limit.mjs && node test/latency-reality.mjs

# physics against the real Gymnasium
uv venv /tmp/cpenv --python 3.12 && uv pip install --python /tmp/cpenv/bin/python gymnasium
PYTHON=/tmp/cpenv/bin/python node test/compare.mjs

# these need a key
node tools/dev-proxy.mjs &
TYPESAFE_API_KEY=... node test/control-quality.mjs --episodes 2
TYPESAFE_API_KEY=... node test/force-grading.mjs --episodes 3
```

## License

This project is released under the [MIT License](LICENSE).

The CartPole implementation derives from Gymnasium (Farama Foundation), BSD-3-Clause; the equations
originate in Barto, Sutton & Anderson (1983) via
[the 2005 cart-pole note](https://coneural.org/florian/papers/05_cart_pole.pdf).
