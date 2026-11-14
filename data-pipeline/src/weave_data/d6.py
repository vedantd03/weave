"""Macroscopic consistency of the Chennai data (D6) and the per-minute fundamental diagram.

Everything here uses positions only (front position x, time t). The only external numbers are
the paper's (Kanagaraj, Asaithambi, Toledo & Lee 2015, TRR 2491):
  PAPER_FLOW_VPH    = 6010  veh/h  (compared with our line counts)
  PAPER_DENSITY_VPK = 123.5 veh/km (NOT an expected value: 6010 / 123.5 = 48.7 km/h, which
                                    contradicts the paper's own speeds; recorded only)

Tracked region: tracking starts and ends at varying positions near the section ends, so the
analysis uses only x ∈ [x_lo, x_hi], where x_lo is the TRACK_Q upper quantile of the
positions at which vehicles are first observed and x_hi the TRACK_Q lower quantile of the
positions at which they are last observed.

Analysis period per file: [t_min + τ, t_max − τ], τ = the TRACK_Q quantile of the time
vehicles take to traverse the tracked region. Any vehicle inside the region during the period
then entered the section after the file starts and leaves before it ends, so it is observed.

Edie's generalised definitions over the region R = [x_lo, x_hi] × [t_a, t_b] (trajectories
linearly interpolated between samples and clipped exactly to R):
  q = Σ distance / (L·T),  k = Σ time / (L·T),  v_s = Σ distance / Σ time.

Density agreement bound: with monotone trajectories and no vehicle appearing or vanishing
inside R, the Edie flow equals the average over all lines x ∈ [x_lo, x_hi] of the line
counts, and any two line counts differ by at most n(t_a) + n(t_b), the numbers of vehicles
inside the region at the period's ends (a vehicle can cross one line but not another within
the period only if it is between them at t_a or t_b). Hence
  |k − q_lines / v_s| ≤ (n(t_a) + n(t_b)) / (T · v_s).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

PAPER_FLOW_VPH = 6010.0
PAPER_DENSITY_VPK = 123.5
TRACK_Q = 0.99
N_LINES = 5
SEG_GAP_S = 0.75


def tracked_region(df: pd.DataFrame, q: float = TRACK_Q) -> dict:
    """Vehicles already inside the section when a file starts (first seen at the file's first
    instant) or still inside when it ends are excluded from the first/last-position
    statistics: their first/last positions reflect the recording window, not tracking."""
    g = df.groupby("key")["x"]
    i_first = df.groupby("key")["t"].idxmin()
    i_last = df.groupby("key")["t"].idxmax()
    files = df["file"] if "file" in df else pd.Series("_", index=df.index)
    t_lo = df.groupby(files)["t"].transform("min")
    t_hi = df.groupby(files)["t"].transform("max")
    keep_f = (df.loc[i_first, "t"] > t_lo.loc[i_first] + SEG_GAP_S).to_numpy()
    keep_l = (df.loc[i_last, "t"] < t_hi.loc[i_last] - SEG_GAP_S).to_numpy()
    first = df.loc[i_first, "x"].to_numpy()[keep_f]
    last = df.loc[i_last, "x"].to_numpy()[keep_l]
    x_lo = float(np.quantile(first, q))
    x_hi = float(np.quantile(last, 1 - q))
    if not x_hi > x_lo:
        raise ValueError(f"no fully tracked region: x_lo={x_lo}, x_hi={x_hi}")
    inner = (keep_f & keep_l)
    span = ((g.min() <= x_lo) & (g.max() >= x_hi)).to_numpy()[inner].mean()
    return {"x_lo": x_lo, "x_hi": x_hi, "length_m": x_hi - x_lo,
            "section_x_range": [float(df["x"].min()), float(df["x"].max())],
            "first_x_quantiles": [float(v) for v in np.quantile(first, [0.5, 0.9, q, 1.0])],
            "last_x_quantiles": [float(v) for v in np.quantile(last, [0.0, 1 - q, 0.1, 0.5])],
            "fraction_spanning": float(span)}


def _pairs(df: pd.DataFrame):
    """Consecutive sample pairs within each trajectory (no time gaps)."""
    d = df.sort_values(["key", "t"])
    k = d["key"].to_numpy()
    t = d["t"].to_numpy(float)
    x = d["x"].to_numpy(float)
    same = (k[1:] == k[:-1]) & (np.diff(t) <= SEG_GAP_S)
    return k[:-1][same], t[:-1][same], t[1:][same], x[:-1][same], x[1:][same]


def crossing_times(df: pd.DataFrame, X: float) -> pd.Series:
    """First time each vehicle's front crosses x = X upwards (linear interpolation)."""
    k, t0, t1, x0, x1 = _pairs(df)
    m = (x0 < X) & (x1 >= X)
    tc = t0[m] + (X - x0[m]) / (x1[m] - x0[m]) * (t1[m] - t0[m])
    return pd.Series(tc, index=k[m]).groupby(level=0).min()


def traverse_times(df: pd.DataFrame, x_lo: float, x_hi: float) -> np.ndarray:
    a = crossing_times(df, x_lo)
    b = crossing_times(df, x_hi)
    both = a.index.intersection(b.index)
    return (b[both] - a[both]).to_numpy()


def period(df: pd.DataFrame, region: dict, q: float = TRACK_Q) -> dict:
    tau = float(np.quantile(traverse_times(df, region["x_lo"], region["x_hi"]), q))
    t_min, t_max = float(df["t"].min()), float(df["t"].max())
    return {"t_a": t_min + tau, "t_b": t_max - tau, "tau_s": tau, "T_s": t_max - t_min - 2 * tau,
            "file_t_range": [t_min, t_max]}


def edie(df: pd.DataFrame, x_lo: float, x_hi: float, t_a: float, t_b: float) -> dict:
    _, t0, t1, x0, x1 = _pairs(df)
    dt, dx = t1 - t0, x1 - x0
    s0 = np.zeros_like(t0)
    s1 = np.ones_like(t0)
    with np.errstate(divide="ignore", invalid="ignore"):
        for lo, hi, p0, dp in ((t_a, t_b, t0, dt), (x_lo, x_hi, x0, dx)):
            moving = dp != 0
            ra = np.where(moving, (lo - p0) / dp, -np.inf)
            rb = np.where(moving, (hi - p0) / dp, np.inf)
            enter = np.minimum(ra, rb)
            leave = np.maximum(ra, rb)
            inside_static = (p0 >= lo) & (p0 <= hi)
            enter = np.where(moving, enter, np.where(inside_static, -np.inf, np.inf))
            leave = np.where(moving, leave, np.where(inside_static, np.inf, -np.inf))
            s0 = np.maximum(s0, enter)
            s1 = np.minimum(s1, leave)
    frac = np.clip(s1 - s0, 0, None)
    tot_t = float(np.sum(frac * dt))
    tot_d = float(np.sum(frac * dx))
    L, T = x_hi - x_lo, t_b - t_a
    q = tot_d / (L * T)
    k = tot_t / (L * T)
    return {"flow_vph": q * 3600, "density_vpkm": k * 1000, "speed_kmh": (tot_d / tot_t) * 3.6
            if tot_t > 0 else math.nan, "total_time_s": tot_t, "total_dist_m": tot_d}


def count_in_region(df: pd.DataFrame, x_lo: float, x_hi: float, t: float) -> int:
    _, t0, t1, x0, x1 = _pairs(df)
    m = (t0 <= t) & (t1 > t)
    xt = x0[m] + (t - t0[m]) / (t1[m] - t0[m]) * (x1[m] - x0[m])
    return int(np.sum((xt >= x_lo) & (xt <= x_hi)))


def line_counts(df: pd.DataFrame, region: dict, per: dict, n_lines: int = N_LINES) -> dict:
    L = region["length_m"]
    xs = [region["x_lo"] + (i + 0.5) / n_lines * L for i in range(n_lines)]
    counts = []
    for X in xs:
        tc = crossing_times(df, X)
        counts.append(int(((tc >= per["t_a"]) & (tc < per["t_b"])).sum()))
    T = per["T_s"]
    return {"lines_x": xs, "counts": counts, "T_s": T,
            "flow_vph_per_line": [c / T * 3600 for c in counts],
            "flow_vph": float(np.mean(counts)) / T * 3600}


def file_d6(df: pd.DataFrame, region: dict) -> dict:
    per = period(df, region)
    lines = line_counts(df, region, per)
    ed = edie(df, region["x_lo"], region["x_hi"], per["t_a"], per["t_b"])
    n_a = count_in_region(df, region["x_lo"], region["x_hi"], per["t_a"])
    n_b = count_in_region(df, region["x_lo"], region["x_hi"], per["t_b"])
    k_check = ed["density_vpkm"] - lines["flow_vph"] / ed["speed_kmh"]
    k_bound = (n_a + n_b) / (per["T_s"] / 3600) / ed["speed_kmh"]
    return {"period": per, "lines": lines, "edie": ed, "n_at_t_a": n_a, "n_at_t_b": n_b,
            "flow_lines_over_speed_vpkm": lines["flow_vph"] / ed["speed_kmh"],
            "density_diff_vpkm": k_check, "density_bound_vpkm": k_bound}


def analyse(dfs: dict[str, pd.DataFrame]) -> dict:
    """D6 over all files with ONE tracked region (from all trajectories) and a per-file period."""
    region = tracked_region(pd.concat(dfs.values(), ignore_index=True))
    files = {k: file_d6(df, region) for k, df in dfs.items()}
    return {"region": region, "files": files, "total": combine(region, files)}


def combine(region: dict, results: dict[str, dict]) -> dict:
    """Total over files (same region): counts, times and Edie sums add.

    Flow tolerance: 3·sqrt(sd_poisson² + sd_lines²), with sd_poisson = √N̄/T (Poisson error of
    one line count; the lines count largely the same vehicles, so it is not divided by √K) and
    sd_lines the standard deviation of the K line flows.
    """
    T = sum(r["period"]["T_s"] for r in results.values())
    L = region["length_m"]
    n_lines = len(next(iter(results.values()))["lines"]["counts"])
    per_line = [sum(r["lines"]["counts"][i] for r in results.values()) for i in range(n_lines)]
    mean_count = float(np.mean(per_line))
    q_lines = mean_count / T * 3600
    sd_poisson = math.sqrt(mean_count) / T * 3600
    sd_lines = float(np.std(np.array(per_line) / T * 3600, ddof=1)) if n_lines > 1 else 0.0
    tol = 3.0 * math.hypot(sd_poisson, sd_lines)
    tot_t = sum(r["edie"]["total_time_s"] for r in results.values())
    tot_d = sum(r["edie"]["total_dist_m"] for r in results.values())
    k = tot_t / (L * T) * 1000
    q_e = tot_d / (L * T) * 3600
    v_s = tot_d / tot_t * 3.6
    n_ends = sum(r["n_at_t_a"] + r["n_at_t_b"] for r in results.values())
    k_bound = n_ends / (T / 3600) / v_s
    return {
        "T_s": T, "line_counts_total": per_line, "flow_lines_vph": q_lines,
        "sd_poisson_vph": sd_poisson, "sd_lines_vph": sd_lines, "flow_tolerance_vph": tol,
        "paper_flow_vph": PAPER_FLOW_VPH, "flow_minus_paper_vph": q_lines - PAPER_FLOW_VPH,
        "edie_flow_vph": q_e, "edie_density_vpkm": k, "space_mean_speed_kmh": v_s,
        "flow_lines_over_speed_vpkm": q_lines / v_s, "density_bound_vpkm": k_bound,
        "density_diff_vpkm": k - q_lines / v_s, "n_vehicles_at_period_ends": n_ends,
        "paper_density_vpkm": PAPER_DENSITY_VPK,
        "paper_implied_speed_kmh": PAPER_FLOW_VPH / PAPER_DENSITY_VPK,
    }


def speed_ratio(df: pd.DataFrame, v_min: float = 1.0) -> dict:
    """Ratio of position-derived speed to the dataset's speed column on clean samples.

    Groups: class, file, and quartile bins of position-derived speed. Uses the median ratio
    per group. Only samples with v_col > v_min (avoid dividing by ~0) are used.
    """
    d = df[df["win_clean"] & df["kin_ok"] & (df["v_col"] > v_min)].copy()
    d["ratio"] = d["v"] / d["v_col"]
    overall = float(d["ratio"].median())
    d["vbin"] = pd.qcut(d["v"], 4, labels=["q1", "q2", "q3", "q4"])
    groups = {}
    for col in ("cls", "file", "vbin"):
        groups[col] = {str(k): float(v) for k, v in d.groupby(col, observed=True)["ratio"].median().items()}
    devs = [abs(v - overall) / overall for g in groups.values() for v in g.values()]
    iqr = [float(v) for v in d["ratio"].quantile([0.25, 0.75])]
    # least-squares slope through the origin, v ≈ r · v_col (a second estimate of r)
    r_ls = float((d["v"] * d["v_col"]).sum() / (d["v_col"] ** 2).sum())
    return {"median_ratio": overall, "ls_ratio": r_ls, "iqr": iqr, "samples": int(len(d)),
            "groups": groups, "max_rel_group_dev": float(max(devs))}


def minute_points(df: pd.DataFrame, region: dict, per: dict, file_key: str) -> list[dict]:
    pts = []
    t = per["t_a"]
    m = 0
    while t + 60.0 <= per["t_b"] + 1e-9:
        e = edie(df, region["x_lo"], region["x_hi"], t, t + 60.0)
        pts.append({"file": file_key, "minute": m, "tStartS": round(t, 2),
                    "flowVph": round(e["flow_vph"], 1), "densityVpkm": round(e["density_vpkm"], 2),
                    "speedKmh": round(e["speed_kmh"], 2)})
        t += 60.0
        m += 1
    return pts
