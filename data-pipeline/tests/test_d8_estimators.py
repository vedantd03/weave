"""D8: the clearance and T estimators recover known values on synthetic data."""

import math

import numpy as np
import pandas as pd
import pytest

from weave_data import calibrate as cal
from weave_data.kinematics import add_kinematics

# ------------------------------------------------------------------------------- clearance


def test_neighbour_gaps_constructed_frame():
    # three vehicles side by side (same front, same length) plus one far ahead
    x = np.array([50.0, 50.0, 50.0, 90.0])
    length = np.array([4.0, 4.0, 4.0, 4.0])
    y = np.array([1.0, 2.5, 5.0, 2.0])
    w = np.array([0.8, 1.6, 2.0, 1.6])
    i, j, g = cal.frame_neighbour_gaps(x, length, y, w)
    pairs = {(int(a), int(b)): float(c) for a, b, c in zip(i, j, g)}
    # gap = (y_j − w_j/2) − (y_i + w_i/2): (2.5−0.8) − (1+0.4) = 0.3; (5−1) − (2.5+0.8) = 0.7
    assert pairs.keys() == {(0, 1), (1, 2)}
    assert pairs[(0, 1)] == pytest.approx(0.3)
    assert pairs[(1, 2)] == pytest.approx(0.7)


def test_longitudinal_overlap_required():
    # rear of the second (x − l = 46) is ahead of the first's front (45): not side by side
    i, _, _ = cal.frame_neighbour_gaps(np.array([45.0, 50.0]), np.array([4.0, 4.0]),
                                       np.array([1.0, 3.0]), np.array([1.0, 1.0]))
    assert len(i) == 0


def _pairs_frame(gaps, speeds=None):
    rows = []
    for k, g in enumerate(gaps):
        wl, wr = 0.7, 1.7
        yl = 2.0
        yr = yl + wl / 2 + g + wr / 2
        v = 10.0 if speeds is None else speeds[k]
        for vid, (yy, ww, cls) in enumerate(((yl, wl, "motorcycle"), (yr, wr, "car"))):
            rows.append({"file": "s", "t": k * 0.5, "key": f"s:{vid}", "x": 100.0, "length": 4.0,
                         "y": yy, "width": ww, "cls": cls, "flag": 0, "v": v})
    return pd.DataFrame(rows)


def test_clearance_estimator_recovers_known_value():
    rng = np.random.default_rng(11)
    c_true, a = 0.15, 0.05
    n = 4000
    # accepted gaps g = 2c + q, q ~ U(−a, 9a): P(g < 2c) = 0.1 exactly, so Q10(g) = 2c
    gaps = 2 * c_true + rng.uniform(-a, 9 * a, n)
    g = cal.lateral_gaps(_pairs_frame(gaps))
    assert len(g) == n
    c_hat = cal.clearance_from_gaps(g["gap"].to_numpy(), 0.10)
    # order-statistic bound: the sample p10 sits at a CDF level within 0.1 ± 4·sqrt(0.09/n);
    # the gap CDF has slope 1/(10a), so |ĉ − c| ≤ 10a·4·sqrt(0.09/n)/2
    tol = 10 * a * 4 * math.sqrt(0.09 / n) / 2
    assert abs(c_hat - c_true) <= tol
    # the median-based estimate would be far off (Q50 = 2c + 4a ⇒ c + 2a)
    assert cal.clearance_from_gaps(g["gap"].to_numpy(), 0.5) > c_true + 1.5 * a


def test_c1_identified_when_speed_range_and_slope_present():
    rng = np.random.default_rng(5)
    n = 6000
    c0, c1, a = 0.1, 0.01, 0.05
    v = rng.uniform(2.0, 16.0, n)
    gaps = 2 * (c0 + c1 * v) + rng.uniform(-a, 9 * a, n)
    fit = cal.fit_c1(cal.lateral_gaps(_pairs_frame(gaps, v)))
    assert fit["identified"]
    # per-bin p10 equals 2(c0 + c1·v) at the bin's speeds, so the slope is 2·c1 up to the
    # within-bin spread of v (bins 2 m/s wide, uniform v ⇒ linear in v) and sampling noise:
    # each bin p10 has CDF-level error ≲ 4·sqrt(0.09/n_bin) → value error ≤ 10a·4·sqrt(0.09/750)
    # over a 12 m/s span the slope error is ≤ 2·that/12
    tol = 2 * (10 * a * 4 * math.sqrt(0.09 / 750)) / 12
    assert fit["slope_gap"] == pytest.approx(2 * c1, abs=tol)


def test_c1_not_identified_without_speed_range():
    rng = np.random.default_rng(6)
    n = 6000
    v = rng.uniform(10.0, 13.0, n)  # 3 m/s < C1_MIN_SPEED_SPAN
    gaps = 0.3 + rng.uniform(-0.05, 0.45, n)
    assert not cal.fit_c1(cal.lateral_gaps(_pairs_frame(gaps, v)))["identified"]


# ------------------------------------------------------------------------------------- T


def s_eq(v, T, s0, v0):
    # MODEL §1.3 equilibrium gap
    return (s0 + v * T) / np.sqrt(1 - (v / v0) ** 4)


def test_invert_T_exact_on_equilibrium():
    rng = np.random.default_rng(1)
    T, s0, v0 = 1.3, 2.0, 16.0
    v = rng.uniform(3.0, 0.95 * v0, 1000)
    got = cal.invert_T(s_eq(v, T, s0, v0), v, v0, s0)
    assert np.allclose(got, T, rtol=1e-12, atol=1e-12)


def test_invert_T_undefined_at_or_above_v0():
    got = cal.invert_T(np.array([30.0, 30.0]), np.array([16.0, 17.0]), 16.0, 2.0)
    assert np.isnan(got).all()


def test_T_sensitivity_table_shape():
    v = np.linspace(4, 12, 50)
    rows = cal.T_sensitivity(s_eq(v, 1.2, 2.0, 15.0), v, 15.0, 2.0)
    assert {(r["s0"], r["v0_factor"]) for r in rows} == {
        (s, f) for s in (1.0, 2.0, 3.0) for f in (0.9, 1.0, 1.1)}
    centre = [r for r in rows if r["s0"] == 2.0 and r["v0_factor"] == 1.0][0]
    assert centre["T"] == pytest.approx(1.2, abs=1e-12)
    # larger s0 ⇒ smaller T at fixed s (∂T/∂s0 = −1/v < 0)
    by = {(r["s0"], r["v0_factor"]): r["T"] for r in rows}
    assert by[(3.0, 1.0)] < by[(2.0, 1.0)] < by[(1.0, 1.0)]


def test_end_to_end_T_from_synthetic_platoons():
    """Two lanes of platoons in IDM equilibrium (known T, s0, v0), sampled like the data;
    leaders found with the engine rule, steady samples selected, T inverted."""
    T, s0, v0 = 1.3, 2.0, 16.0
    W, width, length = 7.0, 1.7, 4.0
    rows = []
    for lane, (yc, v) in enumerate(((1.75, 8.0), (5.25, 11.0))):
        gap = float(s_eq(v, T, s0, v0))
        for k in range(10):
            front0 = 200.0 - k * (gap + length)
            for step in range(61):
                t = step * 0.5
                rows.append({"file": "s", "key": f"s:{lane}-{k}", "t": t, "x": front0 + v * t,
                             "y": yc, "width": width, "length": length, "cls": "car", "flag": 0})
    df = add_kinematics(pd.DataFrame(rows))
    fs = cal.follower_samples(df, {"car": (0.2, 0.0)}, W)
    st = cal.steady(fs)
    # 9 followers per lane × 61 instants, all steady (a = 0, Δv = 0, v ≥ 3 m/s, gap ≤ 60 m)
    assert len(st) == 2 * 9 * 61
    Tm, n, nx = cal.T_median(st["gap"], st["v"], v0, s0)
    assert nx == 0 and n == len(st)
    assert Tm == pytest.approx(T, abs=1e-9)
