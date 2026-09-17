/**
 * Turning CartPole state into something Jev can reason about.
 *
 * THIS is the interesting design surface of the whole demo. Jev does not receive
 * physics, pixels or a simulation handle: it receives text and a question. How you
 * phrase the state decides how well it can answer. Flip between these
 * representations mid-episode and watch the score move.
 */

import { X_THRESHOLD, THETA_THRESHOLD, toDegrees } from './cartpole.js';

const side = (v) => (v >= 0 ? 'right' : 'left');
const abs = Math.abs;

// ---------------------------------------------------------------------------
// representation 1: raw numbers as JSON
// ---------------------------------------------------------------------------
function raw(s) {
  return {
    cart_position: +s.x.toFixed(4),
    cart_velocity: +s.xDot.toFixed(4),
    pole_angle_degrees: +toDegrees(s.theta).toFixed(3),
    pole_angular_velocity_deg_per_s: +toDegrees(s.thetaDot).toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// representation 2: plain prose, one sentence per physical quantity
// ---------------------------------------------------------------------------
function prose(s) {
  const angleDeg = toDegrees(s.theta);
  const rateDeg = toDegrees(s.thetaDot);
  const pct = (abs(s.x) / X_THRESHOLD) * 100;

  const where = abs(s.x) < 0.5 ? 'near the centre of the track' : `${abs(s.x).toFixed(2)} m ${side(s.x)} of centre`;
  const cartMove =
    abs(s.xDot) < 0.2 ? 'almost stationary' : `moving ${side(s.xDot)} at ${abs(s.xDot).toFixed(2)} m/s`;
  const lean = `${abs(angleDeg).toFixed(1)}° ${side(angleDeg)} of upright`;
  const fall =
    abs(rateDeg) < 5
      ? 'roughly holding its angle'
      : `rotating further ${side(rateDeg)} at ${abs(rateDeg).toFixed(0)}°/s`;

  return (
    `Cart: ${where} (${pct.toFixed(0)}% of the way to the end of the track), ${cartMove}.\n` +
    `Pole: leaning ${lean}, and ${fall}.\n` +
    `The episode ends if the pole passes ${toDegrees(THETA_THRESHOLD).toFixed(0)}° from upright or the cart reaches the end of the track.`
  );
}

// ---------------------------------------------------------------------------
// representation 3: qualitative buckets -- no numbers at all
// ---------------------------------------------------------------------------
function bucket(v, edges, labels) {
  const a = abs(v);
  for (let i = 0; i < edges.length; i++) if (a < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

function coarse(s) {
  const angleDeg = toDegrees(s.theta);
  const rateDeg = toDegrees(s.thetaDot);

  const lean = bucket(angleDeg, [1, 5, 9, 12], ['nearly upright', 'leaning slightly', 'leaning noticeably', 'leaning a lot', 'about to fall']);
  const fall = bucket(rateDeg, [5, 20, 60], ['barely rotating', 'drifting', 'falling steadily', 'falling fast']);
  const place = bucket(s.x, [0.6, 1.5, 2.0, 2.4], ['near the centre', 'off-centre', 'near the end', 'almost out of track', 'out']);
  const drift = bucket(s.xDot, [0.2, 0.8], ['almost still', 'drifting', 'sliding fast']);

  return {
    pole: `${lean}, and ${fall} to the ${side(angleDeg)}`,
    cart: `${place}, ${drift} to the ${side(s.xDot)}`,
  };
}

export const REPRESENTATIONS = {
  prose: {
    label: 'Prose',
    hint: 'full sentences, degrees included — closest to how a human would describe it',
    build: prose,
  },
  raw: {
    label: 'Raw JSON',
    hint: 'bare numbers, no interpretation — lets the model do its own arithmetic',
    build: raw,
  },
  coarse: {
    label: 'Coarse',
    hint: 'qualitative buckets only, no numbers — shortest, but throws away magnitude',
    build: coarse,
  },
};

export function buildState(state, representation) {
  const spec = REPRESENTATIONS[representation] ?? REPRESENTATIONS.prose;
  return spec.build(state);
}
