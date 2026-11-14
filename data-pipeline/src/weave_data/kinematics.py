"""Position-derived kinematics.

The dataset's speed and acceleration columns are ~1.9x too low relative to the positions,
so longitudinal speed v, longitudinal acceleration a and lateral speed vy are recomputed from
positions: Savitzky–Golay smoothing-differentiation (local quadratic least squares) on each
contiguous trajectory segment, then physical-bound and jerk checks.

Windows (0.5 s sampling):
* v, vy: 5 points (2 s), quadratic.
* a: 9 points (4 s), quadratic (second derivative needs a longer window to control noise).
A local quadratic fit is exact for x(t) = x0 + v t + a t²/2, so on such trajectories the only
error is noise, with standard deviation σ·‖c‖₂ for the linear filter weights c (test D1).
Edges use the polynomial fitted to the first/last full window (scipy `mode='interp'`).

Checks (samples failing any are excluded from microscopic fits via `kin_ok`):
* |a| ≤ 9 m/s² (B_MAX, docs/MODEL.md §1.3: physical braking limit);
* |jerk| ≤ 15 m/s³, a commonly used plausibility bound for reconstructed vehicle
  trajectories (Punzo, Borzacchiello & Ciuffo 2011, Transp. Res. C 19(6); Montanino &
  Punzo 2015, Transp. Res. B 80);
* v ≥ −0.5 m/s (no reversing beyond noise), |vy| ≤ 3 m/s.
`win_clean` is False if any row inside the acceleration window of a sample has flag ≠ 0.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter

DT_S = 0.5
V_WINDOW = 5
A_WINDOW = 9
ORDER = 2
A_MAX_ABS = 9.0
JERK_MAX = 15.0
V_MIN = -0.5
VY_MAX = 3.0
GAP_SPLIT_S = 0.75  # a time step longer than this starts a new segment


def sg(x: np.ndarray, window: int, deriv: int, dt: float = DT_S, order: int = ORDER) -> np.ndarray:
    """Savitzky–Golay derivative of a uniformly sampled series; NaN if too short."""
    x = np.asarray(x, dtype=float)
    if len(x) < window:
        return np.full(len(x), np.nan)
    return savgol_filter(x, window, order, deriv=deriv, delta=dt, mode="interp")


def segment_ids(t: np.ndarray) -> np.ndarray:
    return np.concatenate([[0], np.cumsum(np.diff(t) > GAP_SPLIT_S)])


def _segment_kin(t: np.ndarray, x: np.ndarray, y: np.ndarray, flag: np.ndarray):
    n = len(t)
    v = sg(x, V_WINDOW, 1)
    a = sg(x, A_WINDOW, 2)
    vy = sg(y, V_WINDOW, 1)
    jerk = np.gradient(a, DT_S) if n >= 2 and np.isfinite(a).all() else np.full(n, np.nan)
    bad = (flag != 0).astype(float)
    h = A_WINDOW // 2
    if n:
        kern = np.ones(2 * h + 1)
        near_bad = np.convolve(np.pad(bad, h), kern, mode="valid") > 0
    else:
        near_bad = np.zeros(0, bool)
    return v, a, vy, jerk, ~near_bad


def add_kinematics(df: pd.DataFrame) -> pd.DataFrame:
    """Add v, a, vy, jerk, kin_ok, win_clean, seg. `df` sorted by (key, t)."""
    df = df.sort_values(["key", "t"]).reset_index(drop=True)
    out = {k: np.full(len(df), np.nan) for k in ("v", "a", "vy", "jerk")}
    clean = np.zeros(len(df), bool)
    seg_col = np.zeros(len(df), np.int64)
    keys = df["key"].to_numpy()
    t = df["t"].to_numpy(float)
    x = df["x"].to_numpy(float)
    y = df["y"].to_numpy(float)
    fl = df["flag"].to_numpy()
    bounds = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1], True])
    next_seg = 0
    for b0, b1 in zip(bounds[:-1], bounds[1:]):
        sid = segment_ids(t[b0:b1])
        for s in np.unique(sid):
            idx = np.arange(b0, b1)[sid == s]
            v, a, vy, j, ok = _segment_kin(t[idx], x[idx], y[idx], fl[idx])
            out["v"][idx], out["a"][idx], out["vy"][idx], out["jerk"][idx] = v, a, vy, j
            clean[idx] = ok
            seg_col[idx] = next_seg
            next_seg += 1
    for k, vals in out.items():
        df[k] = vals
    df["seg"] = seg_col
    df["win_clean"] = clean & (df["flag"].to_numpy() == 0)
    fin = np.isfinite(df["v"]) & np.isfinite(df["a"]) & np.isfinite(df["vy"])
    df["kin_ok"] = (fin & (df["a"].abs() <= A_MAX_ABS) & (df["jerk"].abs() <= JERK_MAX)
                    & (df["v"] >= V_MIN) & (df["vy"].abs() <= VY_MAX))
    return df


def fit_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows usable for microscopic fits: flag 0 everywhere in the window, checks passed."""
    return df[df["win_clean"] & df["kin_ok"]]


def check_summary(df: pd.DataFrame) -> dict:
    fin = np.isfinite(df["a"])
    return {
        "rows": int(len(df)),
        "rows_with_kinematics": int(fin.sum()),
        "fail_accel_bound": int((df["a"].abs() > A_MAX_ABS).sum()),
        "fail_jerk_bound": int((df["jerk"].abs() > JERK_MAX).sum()),
        "fail_reverse": int((df["v"] < V_MIN).sum()),
        "fail_lateral_speed": int((df["vy"].abs() > VY_MAX).sum()),
        "flag_nonzero_rows": int((df["flag"] != 0).sum()),
        "fit_rows": int((df["win_clean"] & df["kin_ok"]).sum()),
    }
