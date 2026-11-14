"""Deliberate lateral moves (episodes) and the lateral speed limit maxSpeedMps.

The p95 of |lateral speed| over all samples is dominated by slow drift, which made a 3.5 m
lane crossing take 7–10 s in the model. maxSpeedMps is therefore taken from the peak lateral
speed of DELIBERATE moves:

* Lateral position noise σ_y: the flat high-frequency floor of the pooled spectrum of lateral
  position residuals (same method as for x).
* Smoothing: episodes are detected on 5-point (2 s) quadratic Savitzky–Golay smoothed position;
  lateral speed for the peak uses the 3-point window (central difference, Δt = 1 s), because a
  peak needs little smoothing: lateral noise is small (σ_vy = √2·σ_y / 1 s ≈ 0.02 m/s) while
  the 5-point window keeps only ~85 % of the peak of a 4 s raised-cosine lane change (3-point:
  95 %; see `sg_peak_gain`).
* Episode rule: on the smoothed position of each contiguous flag-free stretch, turning points
  are found with hysteresis δ: a reversal counts only once the position has moved back by more
  than δ from the running extreme. δ = 4·√2·σ_s, where σ_s = σ_y·‖c₀‖ is the noise sd of the
  smoothed position (a difference of two smoothed values has sd √2·σ_s; 4 sd). A run between
  two turning points is split at dwells (|vy| on the 5-point smoothing below 4 sd of its noise,
  4·σ_y·‖c₁‖, for ≥ 2 s), so a pause separates two moves in the same direction; a move spans
  from the end of one dwell to the start of the next. A part with |Δy| ≥ 1 m is an episode if at least 2 s of data precede its
  start and follow its end (otherwise it may not be fully observed; counted, not used).
* Per episode: displacement, duration between the turning points, the 10–90 % displacement
  duration, and the peak |lateral speed| inside the episode.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .kinematics import DT_S, sg

WINDOW = 5      # detection smoothing (position)
VY_WINDOW = 3   # lateral speed for the peak (central difference)
MIN_DISP_M = 1.0
EPISODE_Q = 0.85
MIN_EPISODES = 30


def sg_weights(window: int, deriv: int, dt: float = DT_S) -> np.ndarray:
    h = window // 2
    tau = np.arange(-h, h + 1) * dt
    P = np.linalg.pinv(np.vander(tau, 3, increasing=True))
    return P[0] if deriv == 0 else P[1]


def hysteresis(sigma_y: float, window: int = WINDOW) -> float:
    return 4.0 * math.sqrt(2.0) * sigma_y * float(np.linalg.norm(sg_weights(window, 0)))


def turning_points(y: np.ndarray, delta: float) -> list[int]:
    """Indices of the extremes of a zig-zag with hysteresis delta: a new extreme is confirmed
    when the series moves back from the running extreme by more than delta. The first index
    is the extreme from which the first move > delta starts; the last is the final running
    extreme."""
    n = len(y)
    if n < 2:
        return [0] if n else []
    tps: list[int] = []
    direction, lo_i, hi_i, ext = 0, 0, 0, 0
    for i in range(1, n):
        if direction == 0:
            if y[i] > y[hi_i]:
                hi_i = i
            if y[i] < y[lo_i]:
                lo_i = i
            if y[hi_i] - y[lo_i] > delta:
                if hi_i > lo_i:
                    direction, ext = 1, hi_i
                    tps.append(lo_i)
                else:
                    direction, ext = -1, lo_i
                    tps.append(hi_i)
            continue
        if direction == 1:
            if y[i] >= y[ext]:
                ext = i
            elif y[ext] - y[i] > delta:
                tps.append(ext)
                direction, ext = -1, i
        else:
            if y[i] <= y[ext]:
                ext = i
            elif y[i] - y[ext] > delta:
                tps.append(ext)
                direction, ext = 1, i
    if direction != 0:
        tps.append(ext)
    return tps


SETTLE_SAMPLES = 4  # 2 s of data must precede an episode's start and follow its end
DWELL_SAMPLES = 4   # a pause of ≥ 2 s splits a run into separate moves


def dwell_speed(sigma_y: float, window: int = WINDOW) -> float:
    """|vy| below this (4 sd of the 5-point SG slope noise) counts as not moving laterally."""
    return 4.0 * sigma_y * float(np.linalg.norm(sg_weights(window, 1)))


def _moving_parts(moving: np.ndarray) -> list[tuple[int, int]]:
    """Index ranges [i, j] between dwells (runs of ≥ DWELL_SAMPLES non-moving samples). A part
    reaches from the last sample of the previous dwell to the first sample of the next one, so
    the slow start and end of a move stay in it; it must contain a moving sample."""
    n = len(moving)
    still = ~moving
    dwell = np.zeros(n, bool)
    i = 0
    while i < n:
        if still[i]:
            j = i
            while j + 1 < n and still[j + 1]:
                j += 1
            if j - i + 1 >= DWELL_SAMPLES:
                dwell[i:j + 1] = True
            i = j + 1
        else:
            i += 1
    parts, i = [], 0
    while i < n:
        if dwell[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and not dwell[j + 1]:
            j += 1
        if moving[i:j + 1].any():
            parts.append((max(i - 1, 0), min(j + 1, n - 1)))
        i = j + 1
    return parts


def episodes(t: np.ndarray, y: np.ndarray, delta: float, window: int = WINDOW,
             min_disp: float = MIN_DISP_M, sigma_y: float | None = None) -> tuple[list[dict], int]:
    """Episodes in one contiguous stretch. Returns (episodes, n_excluded_at_edges).

    Runs between turning points are split at dwells (|vy₅| < dwell_speed for ≥ 2 s); a part with |Δy| ≥ min_disp is an episode if it is fully observed
    (≥ SETTLE_SAMPLES samples before its start and after its end). sigma_y defaults to the value
    implied by delta."""
    if len(y) < window:
        return [], 0
    if sigma_y is None:
        sigma_y = delta / (4.0 * math.sqrt(2.0) * float(np.linalg.norm(sg_weights(window, 0))))
    ys = sg(y, window, 0)
    v5 = sg(y, window, 1)
    vy = sg(y, VY_WINDOW, 1)
    moving = np.abs(v5) >= dwell_speed(sigma_y, window)
    tps = turning_points(ys, delta)
    out, edge = [], 0
    n = len(y)
    for a, b in zip(tps, tps[1:]):
        for i, j in _moving_parts(moving[a:b + 1]):
            a2, b2 = a + i, a + j
            disp = ys[b2] - ys[a2]
            if abs(disp) < min_disp:
                continue
            if a2 < SETTLE_SAMPLES or b2 > n - 1 - SETTLE_SAMPLES:
                edge += 1
                continue
            frac = (ys[a2:b2 + 1] - ys[a2]) / disp
            i10 = a2 + int(np.argmax(frac >= 0.1))
            i90 = a2 + int(np.argmax(frac >= 0.9))
            out.append({"t0": float(t[a2]), "t1": float(t[b2]), "disp": float(disp),
                        "duration": float(t[b2] - t[a2]), "duration_10_90": float(t[i90] - t[i10]),
                        "peak": float(np.max(np.abs(vy[a2:b2 + 1])))})
    return out, edge


def all_episodes(df: pd.DataFrame, delta: float, sigma_y: float) -> tuple[pd.DataFrame, int]:
    rows, edge = [], 0
    d = df.sort_values(["key", "t"])
    for key, g in d.groupby("key", sort=False):
        t = g["t"].to_numpy(float)
        y = g["y"].to_numpy(float)
        ok = (g["flag"].to_numpy() == 0)
        brk = np.r_[True, (np.diff(t) > 0.75) | ~ok[1:] | ~ok[:-1]]
        sid = np.cumsum(brk)
        for s_ in np.unique(sid):
            m = (sid == s_) & ok
            if m.sum() < WINDOW:
                continue
            eps, e = episodes(t[m], y[m], delta, sigma_y=sigma_y)
            edge += e
            for ep in eps:
                ep["key"] = key
                ep["cls"] = g["cls"].iloc[0]
                rows.append(ep)
    return pd.DataFrame(rows), edge


def sg_peak_gain(duration_s: float, window: int = VY_WINDOW, dt: float = DT_S) -> float:
    """Ratio of SG-estimated to true peak speed for a raised-cosine lateral speed profile of the
    given duration (vy = (D/τ)(1 − cos 2πt/τ)), sampled with the peak on a sample."""
    c = sg_weights(window, 1, dt)
    h = window // 2
    tau = duration_s
    k = np.arange(-h, h + 1) * dt + tau / 2  # window centred on the peak

    def pos(tt):
        tt = np.clip(tt, 0, tau)
        return (tt - tau / (2 * math.pi) * np.sin(2 * math.pi * tt / tau)) / tau  # D = 1

    est = float(np.sum(c * pos(k)))
    return est / (2.0 / tau)


def summarise(ep: pd.DataFrame, classes: list[str]) -> dict:
    """Per class: episode count, mean |displacement|, mean durations, peak percentiles; the
    chosen maxSpeedMps (p85) or the pooled p85 when < MIN_EPISODES (provenance assumption)."""
    pooled = {f"p{q}": float(np.quantile(ep["peak"], q / 100)) for q in (75, 85, 95)} if len(ep) else {}
    out = {"pooled": {"n": int(len(ep)), **pooled}}
    for c in classes:
        e = ep[ep["cls"] == c] if len(ep) else ep
        r = {"n": int(len(e))}
        if len(e):
            r.update({"mean_abs_disp_m": float(e["disp"].abs().mean()),
                      "mean_duration_s": float(e["duration"].mean()),
                      "mean_duration_10_90_s": float(e["duration_10_90"].mean()),
                      **{f"p{q}": float(np.quantile(e["peak"], q / 100)) for q in (75, 85, 95)}})
        own = len(e) >= MIN_EPISODES
        r["value"] = r["p85"] if own else pooled.get("p85", math.nan)
        r["provenance"] = "derived" if own else "assumption"
        r["time_to_cross_3p5m_s"] = 3.5 / r["value"] if r["value"] else math.nan
        out[c] = r
    return out
