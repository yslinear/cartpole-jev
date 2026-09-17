/**
 * How CartPole state is turned into text.
 *
 * THIS is the interesting design surface of the whole demo. Jev does not receive
 * physics, pixels or a simulation handle: it receives text and a question. How you
 * phrase the state decides how well it can answer. Flip between these
 * representations mid-episode and watch the score move.
 *
 * Note what is deliberately absent: any mention of the person watching. A shove
 * is an impulse, so it is unpredictable by construction, and its whole effect is
 * already visible in the velocities below. The model has to recover from a
 * disturbance it can observe but could not have anticipated -- which is the
 * honest description of what it is doing here.
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
function prose(s, thetaLimitRad) {
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

  // Say how much room is left. With the limit raised well past the usual 12
  // degrees, a model that assumes 12 will start bailing out of recoverable
  // situations, so the budget has to be part of the state.
  const budget = abs(angleDeg) / toDegrees(thetaLimitRad);
  const room =
    budget > 0.75
      ? ` That is most of the way to the ${toDegrees(thetaLimitRad).toFixed(0)}° limit.`
      : budget > 0.4
        ? ` There is still room to correct before the ${toDegrees(thetaLimitRad).toFixed(0)}° limit.`
        : '';

  return [
    `Cart: ${where} (${pct.toFixed(0)}% of the way to the end of the track), ${cartMove}.`,
    `Pole: leaning ${lean}, and ${fall}.${room}`,
    `The episode ends if the pole passes ${toDegrees(thetaLimitRad).toFixed(0)}° from upright, or if the cart reaches the end of the track.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// representation 3: qualitative buckets -- no numbers at all
// ---------------------------------------------------------------------------
function bucket(v, edges, labels) {
  const a = abs(v);
  for (let i = 0; i < edges.length; i++) if (a < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

function coarse(s, thetaLimitRad) {
  const angleDeg = toDegrees(s.theta);
  const rateDeg = toDegrees(s.thetaDot);
  const limit = toDegrees(thetaLimitRad);
  // Buckets spread across whatever limit is configured, so they stay meaningful
  // when it is not the usual 12 degrees.
  const cuts = [limit * 0.1, limit * 0.4, limit * 0.7, limit * 0.9];
  const labels = ['nearly upright', 'leaning slightly', 'leaning noticeably', 'leaning a lot', 'about to fall'];

  const lean = bucket(angleDeg, cuts, labels);
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

export function buildState(state, representation, options = {}) {
  const spec = REPRESENTATIONS[representation] ?? REPRESENTATIONS.prose;
  return spec.build(state, options.thetaLimitRad ?? THETA_THRESHOLD);
}
