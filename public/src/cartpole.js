/**
 * CartPole-v1 dynamics.
 *
 * Faithful port of Gymnasium (Farama Foundation) `classic_control/cartpole.py`,
 * BSD-3-Clause. Constants, integrator and termination rules are copied exactly so
 * that scores here are directly comparable to Gymnasium scores (random ~22, solved 500).
 *
 * Reference for the equations:
 *   https://coneural.org/florian/papers/05_cart_pole.pdf
 */

export const GRAVITY = 9.8;
export const MASSCART = 1.0;
export const MASSPOLE = 0.1;
export const TOTAL_MASS = MASSPOLE + MASSCART;
export const LENGTH = 0.5; // actually half the pole's length
export const POLEMASS_LENGTH = MASSPOLE * LENGTH;
export const FORCE_MAG = 10.0;
export const TAU = 0.02; // seconds between physics updates -> 50 Hz
export const THETA_THRESHOLD = (12 * 2 * Math.PI) / 360; // 12 degrees
export const X_THRESHOLD = 2.4;
export const MAX_STEPS = 500; // CartPole-v1 time limit
export const RESET_BOUND = 0.05;

export const ACTION_LEFT = 0;
export const ACTION_RIGHT = 1;

/** Fresh randomised initial state: all four values ~ U(-0.05, 0.05). */
export function resetState() {
  const u = () => Math.random() * (RESET_BOUND * 2) - RESET_BOUND;
  return { x: u(), xDot: u(), theta: u(), thetaDot: u() };
}

/**
 * Advance the simulation by exactly one tau using an arbitrary force in Newtons.
 *
 * The stock CartPole action is +/- FORCE_MAG; this generalisation is what lets a
 * human and the model push the same cart at the same time, with the forces
 * adding. With only the model pushing (or only the human), the arithmetic is
 * bit-for-bit the same as the discrete-action version below, so the Gymnasium
 * equivalence still holds.
 *
 * A force of 0 is legal and means the cart coasts.
 *
 * `limits` optionally overrides the failure bounds. The defaults are Gymnasium's
 * and no caller passes anything in the equivalence test, so that stays exact;
 * the app passes a wider angle because 12 degrees leaves a controller very little
 * room to recover once the world is slow enough to think in.
 */
export function stepForce(state, force, limits = {}) {
  const thetaLimit = limits.theta ?? THETA_THRESHOLD;
  const xLimit = limits.x ?? X_THRESHOLD;

  let { x, xDot, theta, thetaDot } = state;
  const costheta = Math.cos(theta);
  const sintheta = Math.sin(theta);

  const temp = (force + POLEMASS_LENGTH * thetaDot * thetaDot * sintheta) / TOTAL_MASS;
  const thetaacc =
    (GRAVITY * sintheta - costheta * temp) /
    (LENGTH * (4.0 / 3.0 - (MASSPOLE * costheta * costheta) / TOTAL_MASS));
  const xacc = temp - (POLEMASS_LENGTH * thetaacc * costheta) / TOTAL_MASS;

  // explicit Euler (Gymnasium default)
  x = x + TAU * xDot;
  xDot = xDot + TAU * xacc;
  theta = theta + TAU * thetaDot;
  thetaDot = thetaDot + TAU * thetaacc;

  const next = { x, xDot, theta, thetaDot };
  const terminated =
    x < -xLimit || x > xLimit || theta < -thetaLimit || theta > thetaLimit;

  return { state: next, reward: 1, terminated };
}

/**
 * The standard discrete CartPole step. Note the default Gymnasium integrator is
 * *explicit* Euler (they call it "euler"); the semi-implicit variant is opt-in.
 * We match the default so the trajectories are identical.
 */
export function step(state, action, limits) {
  return stepForce(state, action === ACTION_RIGHT ? FORCE_MAG : -FORCE_MAG, limits);
}

/** Degrees are friendlier than radians when we talk to a language model. */
export const toDegrees = (rad) => (rad * 180) / Math.PI;

/**
 * The nine-way sign description of the pole and cart. This is the vocabulary a
 * language model tends to reason with most reliably, and it is what the
 * "coarse" state representation sends.
 */
export function describeState(state) {
  const angleDeg = toDegrees(state.theta);
  const angleRateDeg = toDegrees(state.thetaDot);
  return {
    x: state.x,
    xDot: state.xDot,
    angleDeg,
    angleRateDeg,
  };
}

/**
 * The angle limits offered in the UI, in degrees. 12 is Gymnasium's; the rest
 * are deliberate departures, because 12 degrees is a tight budget once decisions
 * are spaced out. The physics is untouched either way -- only where the episode
 * is called over.
 */
export const GIVE_UP_DEGREES = [8, 12, 20, 30, 45, 60];
