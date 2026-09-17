"""
Reference trajectory using the real Gymnasium, for validating src/cartpole.js.

Run with the throwaway venv:
    /tmp/cpenv/bin/python test/reference.py

It must print a table byte-identical to `node test/physics-check.mjs`.
"""

import os

import gymnasium as gym
import numpy as np

env = gym.make("CartPole-v1")
u = env.unwrapped

# Same fixed start state as the JS harness.
state = np.array([0.01, -0.02, 0.03, 0.0], dtype=np.float64)

# Same PD balancing rule as the JS harness.
GAIN = float(os.environ.get("GAIN", "0.2"))


def controller(s):
    return 1 if (s[2] + GAIN * s[3]) > 0 else 0


lines = []
actions_taken = []
for i in range(400):
    a = controller(state)
    actions_taken.append(a)
    u.state = state
    obs, reward, terminated, truncated, _ = u.step(a)
    state = np.array(u.state, dtype=np.float64)
    if i % 20 == 19 or terminated:
        lines.append(
            f"{i + 1:>4}  a={a}  x={state[0]:.10f}  xDot={state[1]:.10f}  "
            f"th={state[2]:.10f}  thDot={state[3]:.10f}  terminated={terminated}"
        )
    if terminated:
        break

print(f"tau={u.tau}  steps={len(lines)}")
print("\n".join(lines))

# Also report the constants we hard-coded, so any drift is visible.
print(
    "\nconstants:"
    f"\n  gravity={u.gravity} masscart={u.masscart} masspole={u.masspole}"
    f"\n  length={u.length} force_mag={u.force_mag} tau={u.tau}"
    f"\n  x_threshold={u.x_threshold} theta_threshold_radians={u.theta_threshold_radians}"
    f"\n  kinematics_integrator={u.kinematics_integrator}"
    f"\n  reset low/high = -0.05/0.05"
)
