"""D1: speed and acceleration recovery from noisy synthetic positions.

Trajectories x(t) = x0 + v·t + ½·a·t² + ε, ε ~ N(0, σ²), sampled every 0.5 s. A local
quadratic least-squares fit (Savitzky–Golay) is exact for quadratics, so the estimation
error at an interior sample is Gaussian with zero mean and standard deviation σ·‖c‖₂, where c
are the least-squares weights of the derivative at the window centre. The weights are computed
here from the normal equations (numpy pinv of the Vandermonde matrix), independently of the
code under test (which uses scipy.signal.savgol_filter).
"""

import math

import numpy as np
import pandas as pd
from scipy.stats import chi2

from weave_data import kinematics as K

DT = 0.5


def centre_weights(window: int, deriv: int) -> np.ndarray:
    h = window // 2
    tau = np.arange(-h, h + 1) * DT
    A = np.vander(tau, 3, increasing=True)  # columns 1, τ, τ²
    P = np.linalg.pinv(A)                    # rows: coefficients β0, β1, β2
    return P[1] if deriv == 1 else 2.0 * P[2]   # x' = β1, x'' = 2β2 at τ = 0


def test_exact_on_noise_free_quadratics():
    t = np.arange(0, 30, DT)
    for v, a in [(0.0, 0.0), (11.0, 0.0), (8.0, 1.2), (14.0, -2.5)]:
        x = 3.0 + v * t + 0.5 * a * t * t
        # exact up to floating-point rounding of |x| ≲ 10³ m → relative 1e-15 ⇒ 1e-9 is ample
        assert np.allclose(K.sg(x, K.V_WINDOW, 1), v + a * t, atol=1e-9)
        assert np.allclose(K.sg(x, K.A_WINDOW, 2), a, atol=1e-9)


def test_noisy_recovery_within_analytic_bound():
    rng = np.random.default_rng(20261114)
    sigma = 0.15  # m, position noise
    M = 3000      # independent trajectories; one centre sample each → independent errors
    n = 41
    t = np.arange(n) * DT
    mid = n // 2
    ev, ea = np.empty(M), np.empty(M)
    for m in range(M):
        v, a = rng.uniform(0, 16), rng.uniform(-2, 2)
        x = rng.uniform(0, 50) + v * t + 0.5 * a * t * t + rng.normal(0, sigma, n)
        ev[m] = K.sg(x, K.V_WINDOW, 1)[mid] - (v + a * t[mid])
        ea[m] = K.sg(x, K.A_WINDOW, 2)[mid] - a
    for err, w, d in ((ev, K.V_WINDOW, 1), (ea, K.A_WINDOW, 2)):
        sd = sigma * np.linalg.norm(centre_weights(w, d))
        # mean: |ē| ≤ 4.5·sd/√M (two-sided P ≈ 7e-6)
        assert abs(err.mean()) <= 4.5 * sd / math.sqrt(M)
        # variance: M·s²/sd² ~ χ²(M) (mean known to be 0); 99.99 % two-sided bounds
        stat = float(np.sum(err**2)) / sd**2
        assert chi2.ppf(5e-5, M) <= stat <= chi2.ppf(1 - 5e-5, M)
        # every individual error within 5.5 sd (P(any) ≤ M·3.8e-8 ≈ 1e-4)
        assert np.max(np.abs(err)) <= 5.5 * sd


def test_add_kinematics_splits_segments_and_marks_checks():
    t = np.r_[np.arange(0, 10, DT), np.arange(12, 20, DT)]  # 2 s gap → two segments
    x = 10.0 * t
    df = pd.DataFrame({"key": "f:1", "t": t, "x": x, "y": 2.0, "flag": 0})
    out = K.add_kinematics(df)
    assert out["seg"].nunique() == 2
    assert np.allclose(out["v"], 10.0, atol=1e-9)
    assert out["kin_ok"].all()
    # a jump in position of 30 m in one step is a physically impossible acceleration
    df2 = df.copy()
    df2.loc[5, "x"] += 30.0
    out2 = K.add_kinematics(df2)
    assert not out2["kin_ok"].all()
