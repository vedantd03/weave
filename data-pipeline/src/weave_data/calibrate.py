"""Calibration estimators and the classes.json builder.

Order (BRIEF): kinematics → clearance → leaders (which need clearance) → T; plus a, b, v0,
sizes, shares and lateral speed. Every value carries provenance and a note.

Estimators (pure functions, tested on synthetic data in D8):
* Lateral gap between side-by-side neighbours i (left) and j (right) at one instant:
  g = (y_j − w_j/2) − (y_i + w_i/2), where j is the nearest vehicle to the right of i among
  vehicles overlapping i longitudinally ([x − l, x] intervals intersect).
* Clearance c = Q_p(g)/2 with p = 0.10 (sensitivity 0.05, 0.15): a low percentile of the
  gaps drivers accept, halved because the engine adds c on both sides of each vehicle.
* T: invert the IDM equilibrium s = (s0 + vT)/√(1 − (v/v0)⁴) on steady-following samples:
  T = (s·√(1 − (v/v0)⁴) − s0)/v, per-class median.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .chennai_io import CLASS_BY_CODE, CLASS_LABEL
from .leader import find_leaders_np, occupied_np, strip_layout

CLASSES = list(CLASS_BY_CODE.values())
CLEARANCE_Q = 0.10
CLEARANCE_Q_SENS = (0.05, 0.15)
STRIP_WIDTH_M = 0.3   # scenario default (docs/MODEL.md §1.5)
S0_ASSUMED = 2.0      # Treiber & Kesting (2013), Traffic Flow Dynamics, Table 11.2 (city)
V0_QUANTILE = 0.85
A_QUANTILE = 0.95     # a = 95th percentile of position-derived acceleration
B_QUANTILE = 0.05     # b = −(5th percentile)
STEADY_MAX_ABS_A = 0.25   # m/s²
STEADY_MAX_ABS_DV = 0.5   # m/s
STEADY_MIN_V = 3.0        # m/s (T = …/v is ill-conditioned near standstill)
STEADY_MAX_GAP = 60.0     # m (beyond this the follower is not interacting)
C1_MIN_SPEED_SPAN = 6.0   # m/s between the lowest and highest populated speed bins
C1_BIN_WIDTH = 2.0
C1_MIN_BIN_N = 200


# ---------------------------------------------------------------------------------------------
# lateral gaps and clearance


def frame_neighbour_gaps(x, length, y, width) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For one instant: (i, j, gap) for each vehicle i and its nearest right-hand neighbour j
    among vehicles overlapping it longitudinally."""
    x, length, y, width = map(np.asarray, (x, length, y, width))
    n = len(x)
    if n < 2:
        e = np.zeros(0, np.int64)
        return e, e, np.zeros(0)
    rear = x - length
    over = (rear[None, :] < x[:, None]) & (rear[:, None] < x[None, :])
    np.fill_diagonal(over, False)
    right = over & (y[None, :] > y[:, None])
    dy = np.where(right, y[None, :] - y[:, None], np.inf)
    j = np.argmin(dy, axis=1)
    has = right.any(axis=1)
    i = np.flatnonzero(has)
    j = j[has]
    gap = (y[j] - width[j] / 2) - (y[i] + width[i] / 2)
    return i, j, gap


def lateral_gaps(df: pd.DataFrame) -> pd.DataFrame:
    """All neighbour gaps over all instants, between rows with flag 0."""
    d = df[df["flag"] == 0]
    rows = []
    for (_, _), fr in d.groupby(["file", "t"], sort=False):
        if len(fr) < 2:
            continue
        i, j, g = frame_neighbour_gaps(fr["x"].to_numpy(), fr["length"].to_numpy(),
                                       fr["y"].to_numpy(), fr["width"].to_numpy())
        if len(i) == 0:
            continue
        cls = fr["cls"].to_numpy()
        v = fr["v"].to_numpy() if "v" in fr else np.full(len(fr), np.nan)
        rows.append(pd.DataFrame({"gap": g, "cls_i": cls[i], "cls_j": cls[j],
                                  "v_i": v[i], "v_j": v[j]}))
    if not rows:
        return pd.DataFrame(columns=["gap", "cls_i", "cls_j", "v_i", "v_j"])
    out = pd.concat(rows, ignore_index=True)
    out["v_pair"] = (out["v_i"] + out["v_j"]) / 2
    return out


def clearance_from_gaps(gaps: np.ndarray, q: float = CLEARANCE_Q) -> float:
    return float(np.quantile(np.asarray(gaps, float), q)) / 2.0


def gaps_for_class(g: pd.DataFrame, cls: str) -> pd.DataFrame:
    return g[(g["cls_i"] == cls) | (g["cls_j"] == cls)]


def fit_c1(g: pd.DataFrame, q: float = CLEARANCE_Q) -> dict:
    """Speed slope of the low-percentile gap. Identified only if populated speed bins span at
    least C1_MIN_SPEED_SPAN and the OLS slope of per-bin quantiles is > 2 SE from zero."""
    d = g[np.isfinite(g["v_pair"])]
    if d.empty:
        return {"identified": False, "reason": "no speeds"}
    b = np.floor(d["v_pair"] / C1_BIN_WIDTH).astype(int)
    stats = []
    for k, grp in d.groupby(b):
        if len(grp) >= C1_MIN_BIN_N:
            stats.append(((k + 0.5) * C1_BIN_WIDTH, float(np.quantile(grp["gap"], q)), len(grp)))
    if len(stats) < 3:
        return {"identified": False, "reason": f"{len(stats)} populated speed bins", "bins": stats}
    vs = np.array([s[0] for s in stats])
    qs = np.array([s[1] for s in stats])
    span = vs.max() - vs.min()
    A = np.c_[np.ones_like(vs), vs]
    coef, *_ = np.linalg.lstsq(A, qs, rcond=None)
    resid = qs - A @ coef
    dof = len(vs) - 2
    s2 = float(resid @ resid) / dof if dof > 0 else math.inf
    cov = s2 * np.linalg.inv(A.T @ A)
    se = math.sqrt(cov[1, 1]) if np.isfinite(cov[1, 1]) else math.inf
    ident = span >= C1_MIN_SPEED_SPAN and abs(coef[1]) > 2 * se
    return {"identified": bool(ident), "intercept_gap": float(coef[0]), "slope_gap": float(coef[1]),
            "slope_se": se, "speed_span": float(span), "bins": stats,
            "reason": "" if ident else ("speed span too small" if span < C1_MIN_SPEED_SPAN
                                        else "slope not distinguishable from 0 (|b| ≤ 2 SE)")}


# ---------------------------------------------------------------------------------------------
# leaders on the data and steady following


def road_width(df: pd.DataFrame) -> float:
    """Carriageway width seen by the data: 99.9th percentile of vehicles' right edges."""
    return float(np.quantile(df["y"] + df["width"] / 2, 0.999))


def follower_samples(df: pd.DataFrame, clearance: dict[str, tuple[float, float]],
                     W: float, strip_m: float = STRIP_WIDTH_M) -> pd.DataFrame:
    """Leader of every vehicle at every instant with the engine rule (MODEL §1.5–1.6), in
    strip mode with width + 2c(v). All present vehicles take part in the search; the
    returned rows carry the follower's and leader's fit-quality flags."""
    layout = strip_layout(W, strip_m)
    c0 = df["cls"].map({k: v[0] for k, v in clearance.items()}).to_numpy(float)
    c1 = df["cls"].map({k: v[1] for k, v in clearance.items()}).to_numpy(float)
    v = df["v"].to_numpy(float)
    c = c0 + c1 * np.where(np.isfinite(v), np.maximum(v, 0.0), 0.0)
    lo, hi = occupied_np(df["y"].to_numpy(float), df["width"].to_numpy(float), c, layout)
    d = df.assign(_lo=lo, _hi=hi, _ok=(df["win_clean"] & df["kin_ok"]).to_numpy())
    out = []
    for _, fr in d.groupby(["file", "t"], sort=False):
        if len(fr) < 2:
            continue
        front = fr["x"].to_numpy(float)
        ln = fr["length"].to_numpy(float)
        ld = find_leaders_np(front, ln, fr["_lo"].to_numpy(), fr["_hi"].to_numpy())
        m = ld >= 0
        if not m.any():
            continue
        fi = np.flatnonzero(m)
        li = ld[m]
        vv = fr["v"].to_numpy(float)
        out.append(pd.DataFrame({
            "cls": fr["cls"].to_numpy()[fi], "key": fr["key"].to_numpy()[fi],
            "v": vv[fi], "a": fr["a"].to_numpy(float)[fi],
            "gap": (front[li] - ln[li]) - front[fi], "dv": vv[fi] - vv[li],
            "ok": fr["_ok"].to_numpy()[fi] & fr["_ok"].to_numpy()[li],
        }))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def steady(fs: pd.DataFrame) -> pd.DataFrame:
    return fs[fs["ok"] & (fs["a"].abs() < STEADY_MAX_ABS_A) & (fs["dv"].abs() < STEADY_MAX_ABS_DV)
              & (fs["v"] >= STEADY_MIN_V) & (fs["gap"] > 0) & (fs["gap"] <= STEADY_MAX_GAP)]


def invert_T(s, v, v0: float, s0: float) -> np.ndarray:
    """IDM equilibrium inverted for T. NaN where v ≥ v0 (no equilibrium) or v ≤ 0."""
    s = np.asarray(s, float)
    v = np.asarray(v, float)
    r = v / v0
    r2 = r * r
    free = 1.0 - r2 * r2
    with np.errstate(invalid="ignore", divide="ignore"):
        T = (s * np.sqrt(free) - s0) / v
    return np.where((v > 0) & (free > 0), T, np.nan)


def T_median(s, v, v0: float, s0: float) -> tuple[float, int, int]:
    T = invert_T(s, v, v0, s0)
    ok = np.isfinite(T)
    return (float(np.median(T[ok])) if ok.any() else math.nan), int(ok.sum()), int((~ok).sum())


def T_sensitivity(s, v, v0: float, s0: float) -> list[dict]:
    rows = []
    for ds0 in (-1.0, 0.0, 1.0):
        for fv in (0.9, 1.0, 1.1):
            if s0 + ds0 < 0:
                continue
            T, n, nx = T_median(s, v, v0 * fv, s0 + ds0)
            rows.append({"s0": s0 + ds0, "v0": v0 * fv, "v0_factor": fv, "T": T,
                         "n_used": n, "n_no_equilibrium": nx})
    return rows


# ---------------------------------------------------------------------------------------------
# the rest


def spot_speeds(df: pd.DataFrame, X: float) -> pd.DataFrame:
    """Position-derived speed of each vehicle when its front crosses x = X (fit rows only)."""
    d = df.sort_values(["key", "t"])
    k = d["key"].to_numpy()
    x = d["x"].to_numpy(float)
    v = d["v"].to_numpy(float)
    ok = (d["win_clean"] & d["kin_ok"]).to_numpy()
    cls = d["cls"].to_numpy()
    same = k[1:] == k[:-1]
    m = same & (x[:-1] < X) & (x[1:] >= X) & ok[:-1] & ok[1:]
    i = np.flatnonzero(m)
    w = (X - x[i]) / (x[i + 1] - x[i])
    out = pd.DataFrame({"key": k[i], "cls": cls[i], "v": v[i] + w * (v[i + 1] - v[i])})
    return out.drop_duplicates("key")


def size_quantiles(per_vehicle: pd.Series) -> list[float]:
    qs = np.quantile(per_vehicle.to_numpy(float), np.linspace(0, 1, 21))
    return [round(float(v), 3) for v in np.maximum.accumulate(qs)]


def p(value: float, provenance: str, note: str, nd: int = 3) -> dict:
    return {"value": round(float(value), nd), "provenance": provenance, "note": note}


GAP_ACCEPTANCE = {
    # HCM 2016 (TRB), two-way stop control: base critical headway 4.1 s and follow-up 2.2 s
    # (major-street left turn); heavy vehicles +1.0 s critical / +0.9 s follow-up.
    "car": (4.1, 2.2), "motorcycle": (4.1, 2.2), "auto": (4.1, 2.2),
    "bus": (5.1, 3.1), "truck": (5.1, 3.1), "lcv": (5.1, 3.1),
}
GAP_NOTE = ("Not identified by the Chennai data (mid-block section, no priority conflicts). "
            "HCM 2016 (TRB) two-way-stop base values {base}; {extra} Editable assumption.")
POLITENESS = 0.2
THRESHOLD = 0.1
