/**
 * The fixed question set.
 *
 * This object is built ONCE and re-sent unchanged on every decision. Only the
 * `state` varies between calls. There is no caching on the TypeSafe API (the
 * request body is just state + model + questions), so every token here is paid
 * again on every frame -- keep it tight.
 *
 * Question ids never reach the model, so they are free to be descriptive.
 */

export const QUESTIONS = {
  push_right: {
    type: 'noul',
    instructions:
      'A cart on a track carries an upright pole on a free hinge. The cart can only be pushed to the ' +
      'left or to the right, and pushing is the only way to influence the pole. To stop the pole from ' +
      'falling over, should YOU push the cart to the RIGHT on this step?',
    criteria: {
      true: 'Pushing right is the better of the two choices available to you right now.',
      false: 'Pushing left is the better choice for you right now, or neither is meaningfully better.',
    },
  },

  direction: {
    type: 'choice',
    instructions:
      'A cart on a track carries an upright pole on a free hinge. The cart can only be pushed to the ' +
      'left or to the right. Which single direction should YOU push the cart right now to stop the ' +
      'pole from falling over?',
    criteria: {
      push_left: 'You push the cart to the left.',
      push_right: 'You push the cart to the right.',
    },
  },

  falling_right: {
    type: 'noul',
    instructions:
      'Is the pole in this CartPole scene currently rotating towards the right, meaning its lean away ' +
      'from upright is increasing in the rightward direction?',
    criteria: {
      true: 'The pole is tipping to the right.',
      false: 'The pole is tipping to the left, or is not tipping either way.',
    },
  },

  instability: {
    type: 'score',
    instructions: 'How close is this CartPole episode to ending?',
    criteria: [
      'Stable: the pole is nearly upright and barely rotating; no correction is needed.',
      'Drifting: the pole is leaning slightly and rotating slowly; a correction is becoming useful.',
      'Off balance: the pole is clearly leaning and rotating steadily; a correction is needed now.',
      'Critical: the pole is near the failure angle, or the cart is near the end of the track.',
    ],
  },

  push_force: {
    type: 'score',
    instructions:
      'A cart carries an upright pole on a free hinge. The cart is pushed either left or right, and the ' +
      'push has a strength. A strong push corrects a large lean quickly but overshoots a small one, and ' +
      'overshooting is how the pole gets knocked over the other way. How strong should this push be?',
    criteria: [
      'Feather: barely nudge the cart; the pole is close to upright and only needs a light correction.',
      'Moderate: a normal correction; the pole is drifting and needs to be brought back.',
      'Firm: push hard; the pole is leaning clearly and is starting to go.',
      'Maximum: as hard as possible; the pole is about to fall and there is no time to be gentle.',
    ],
  },
};

/**
 * Policies decide which answers drive the cart. Every answer is always fetched
 * (speculative fan-out); the policy only chooses which one to consume, which is
 * a change in code with no extra inference cost.
 *
 * Each returns `{ action, force }`. `force` is newtons, unsigned: the action
 * carries the direction. The fixed policies use `options.baseForceN`, the graded
 * one lets the model set the magnitude itself.
 */

/** Magnitude range the graded policy may pick, as a multiple of the base force. */
export const GRADED_MIN_SCALE = 0.2;
export const GRADED_MAX_SCALE = 1.8;

/**
 * The force to use when a caller does not say. 10 N is the standard CartPole
 * value, so a harness that forgets to pass options keeps behaving like plain
 * CartPole rather than silently pushing with 1 N or NaN.
 */
const DEFAULT_BASE_FORCE_N = 10;
const base = (options) => options?.baseForceN ?? DEFAULT_BASE_FORCE_N;

const fixed = (action, force, extra = {}) => ({ action, force, ...extra });

export const POLICIES = {
  threshold: {
    label: 'P(right) > 0.5',
    hint: 'read the Noul, act on whichever side is more likely, always at the same force',
    decide(answers, _previous, options) {
      const p = answers.push_right?.noul ?? 0.5;
      return fixed(p > 0.5 ? 1 : 0, base(options), {
        confidence: Math.abs(p - 0.5) * 2,
        note: `P(right)=${p.toFixed(2)}`,
      });
    },
  },

  gated: {
    label: 'Confidence-gated',
    hint: 'only move when the Noul is decisive, otherwise hold the previous action',
    decide(answers, previous, options) {
      const p = answers.push_right?.noul ?? 0.5;
      const margin = Math.abs(p - 0.5) * 2; // 0 = coin flip, 1 = certain
      if (margin < 0.3) return fixed(previous ?? 0, base(options), { confidence: margin, note: `held (P(right)=${p.toFixed(2)})` });
      return fixed(p > 0.5 ? 1 : 0, base(options), { confidence: margin, note: `P(right)=${p.toFixed(2)}` });
    },
  },

  choice: {
    label: 'Choice answer',
    hint: 'use the Choice primitive directly and ignore the Noul',
    decide(answers, _previous, options) {
      const c = answers.direction?.choice;
      return fixed(c === 'push_right' ? 1 : 0, base(options), {
        confidence: answers.direction?.confidence ?? 0,
        note: `choice=${c}`,
      });
    },
  },

  composite: {
    label: 'Composite (Noul + Score)',
    hint: 'combine two answers in code, weighted — shows composition without extra inference',
    decide(answers, _previous, options) {
      const p = answers.push_right?.noul ?? 0.5;
      const instability = (answers.instability?.score ?? 0) / 3; // 0..1
      // When the situation is critical, commit harder to the Noul's lean;
      // when it is stable, stay closer to the midpoint and avoid twitching.
      const blended = 0.5 + (p - 0.5) * (0.5 + 0.5 * instability);
      return fixed(blended > 0.5 ? 1 : 0, base(options), {
        confidence: Math.abs(blended - 0.5) * 2,
        note: `P=${p.toFixed(2)} instab=${instability.toFixed(2)}`,
      });
    },
  },

  /**
   * Direction from the Noul, magnitude from a Score -- the model sets both.
   *
   * This is the answer to "can Jev choose how hard to push": yes, and it is the
   * difference between bang-bang control and something closer to proportional.
   * A fixed force held across a long decision interval always overshoots, which
   * is why test/interval-limit.mjs collapses past ~5 steps. A force that shrinks
   * with the error does much less damage over the same interval.
   *
   * The two questions are answered independently and cannot see each other, so
   * direction and magnitude can disagree in principle; in practice the failure
   * mode is mild, and the alternative -- one Choice over signed levels -- buys
   * consistency at the cost of resolution.
   */
  graded: {
    label: 'Direction + force',
    hint: 'direction from the Noul, strength from a Score — the model picks both',
    decide(answers, _previous, options) {
      const p = answers.push_right?.noul ?? 0.5;
      const s = answers.push_force?.score ?? 1; // 0..3
      const scale = GRADED_MIN_SCALE + (s / 3) * (GRADED_MAX_SCALE - GRADED_MIN_SCALE);
      return fixed(p > 0.5 ? 1 : 0, base(options) * scale, {
        confidence: Math.abs(p - 0.5) * 2,
        note: `P(right)=${p.toFixed(2)} force=${s.toFixed(1)}/3 → ${(base(options) * scale).toFixed(1)} N`,
      });
    },
  },
};

/** Rough character count, used to show the per-frame payload cost live in the UI. */
export function questionChars() {
  return JSON.stringify(QUESTIONS).length;
}
