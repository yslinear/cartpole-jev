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
      'falling over, should the cart be pushed to the RIGHT on this step?',
    criteria: {
      true: 'Pushing right is the better of the two available choices right now.',
      false: 'Pushing left is the better choice right now, or neither choice is meaningfully better.',
    },
  },

  direction: {
    type: 'choice',
    instructions:
      'A cart on a track carries an upright pole on a free hinge. The cart can only be pushed to the ' +
      'left or to the right. Which single action should be applied right now to stop the pole from falling over?',
    criteria: {
      push_left: 'Push the cart to the left.',
      push_right: 'Push the cart to the right.',
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
};

/**
 * Policies decide which answers drive the cart. Every answer is always fetched
 * (speculative fan-out); the policy only chooses which one to consume, which is
 * a change in code with no extra inference cost.
 */
export const POLICIES = {
  threshold: {
    label: 'P(right) > 0.5',
    hint: 'read the Noul, act on whichever side is more likely',
    decide(answers) {
      const p = answers.push_right?.noul ?? 0.5;
      return { action: p > 0.5 ? 1 : 0, confidence: Math.abs(p - 0.5) * 2, note: `P(right)=${p.toFixed(2)}` };
    },
  },

  gated: {
    label: 'Confidence-gated',
    hint: 'only move when the Noul is decisive, otherwise hold the previous action',
    decide(answers, previous) {
      const p = answers.push_right?.noul ?? 0.5;
      const margin = Math.abs(p - 0.5) * 2; // 0 = coin flip, 1 = certain
      if (margin < 0.3) return { action: previous ?? 0, confidence: margin, note: `held (P(right)=${p.toFixed(2)})` };
      return { action: p > 0.5 ? 1 : 0, confidence: margin, note: `P(right)=${p.toFixed(2)}` };
    },
  },

  choice: {
    label: 'Choice answer',
    hint: 'use the Choice primitive directly and ignore the Noul',
    decide(answers) {
      const c = answers.direction?.choice;
      return {
        action: c === 'push_right' ? 1 : 0,
        confidence: answers.direction?.confidence ?? 0,
        note: `choice=${c}`,
      };
    },
  },

  composite: {
    label: 'Composite (Noul + Score)',
    hint: 'combine two answers in code, weighted — shows composition without extra inference',
    decide(answers) {
      const p = answers.push_right?.noul ?? 0.5;
      const instability = (answers.instability?.score ?? 0) / 3; // 0..1
      // When the situation is critical, commit harder to the Noul's lean;
      // when it is stable, stay closer to the midpoint and avoid twitching.
      const blended = 0.5 + (p - 0.5) * (0.5 + 0.5 * instability);
      return { action: blended > 0.5 ? 1 : 0, confidence: Math.abs(blended - 0.5) * 2, note: `P=${p.toFixed(2)} instab=${instability.toFixed(2)}` };
    },
  },
};

/** Rough character count, used to show the per-frame payload cost live in the UI. */
export function questionChars() {
  return JSON.stringify(QUESTIONS).length;
}
