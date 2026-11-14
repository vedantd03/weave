"""Chennai calibration run: raw files → kinematics → D6 → clearance → leaders → T, a, b, v0,
sizes, shares → classes.json and chennai_fd.json (+ a JSON report for VALIDATION.md)."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import calibrate as cal
from . import chennai_io as cio
from . import d6
from .kinematics import A_WINDOW, add_kinematics, check_summary, fit_rows

SOURCE = ("Kanagaraj V., Asaithambi G., Toledo T., Lee T.-C. (2015), Trajectory data and flow "
          "characteristics of mixed traffic, Transportation Research Record 2491, 1-11. "
          "Chennai, 2:45-3:15 PM, 0.5 s sampling. Processed by weave_data (positions only).")
MIN_T_SAMPLES = 30
MIN_VEHICLES = 20


def load_all() -> dict[str, pd.DataFrame]:
    files = cio.available_files()
    if len(files) != len(cio.FILES):
        raise FileNotFoundError(cio.missing_reason())
    return {k: add_kinematics(cio.load(k, p)) for k, p in files.items()}


def run(dfs: dict[str, pd.DataFrame]) -> tuple[dict, dict, dict]:
    rep: dict = {"units": {k: cio.check_units(df) for k, df in dfs.items()},
                 "kinematic_checks": {k: check_summary(df) for k, df in dfs.items()}}
    all_df = pd.concat(dfs.values(), ignore_index=True)

    # ---- D6
    d6r = d6.analyse(dfs)
    rep["d6"] = d6r
    rep["speed_ratio"] = d6.speed_ratio(all_df)
    region = d6r["region"]
    x_mid = (region["x_lo"] + region["x_hi"]) / 2

    # ---- per-vehicle facts
    veh = all_df.groupby("key").agg(cls=("cls", "first"), length=("length", "first"),
                                    width=("width", "first"))
    counts = veh["cls"].value_counts()
    n_veh = int(len(veh))
    fit = fit_rows(all_df)

    # ---- clearance (before leaders)
    gaps = cal.lateral_gaps(all_df)
    rep["lateral_gaps"] = {"samples": int(len(gaps)),
                           "negative_fraction": float((gaps["gap"] < 0).mean()) if len(gaps) else math.nan}
    clearance: dict[str, tuple[float, float]] = {}
    clear_rep = {}
    for c in cal.CLASSES:
        g = cal.gaps_for_class(gaps, c)
        if len(g) == 0:
            continue
        c1fit = cal.fit_c1(g)
        sens = {f"p{int(q * 100)}": cal.clearance_from_gaps(g["gap"], q)
                for q in (cal.CLEARANCE_Q_SENS[0], cal.CLEARANCE_Q, cal.CLEARANCE_Q_SENS[1])}
        if c1fit["identified"]:
            c0, c1 = c1fit["intercept_gap"] / 2, c1fit["slope_gap"] / 2
        else:
            c0, c1 = sens["p10"], 0.0
        clear_rep[c] = {"n": int(len(g)), "c_by_percentile": sens, "median_gap": float(g["gap"].median()),
                        "c1_fit": {k: v for k, v in c1fit.items() if k != "bins"},
                        "c0_raw": c0, "c1": c1}
        clearance[c] = (max(0.0, c0), c1)
    pair = gaps.groupby(["cls_i", "cls_j"])["gap"].quantile(cal.CLEARANCE_Q).unstack()
    rep["clearance"] = clear_rep
    rep["gap_p10_by_class_pair"] = {str(i): {str(j): (None if pd.isna(v) else float(v))
                                             for j, v in row.items()} for i, row in pair.iterrows()}

    # ---- leaders and steady following
    W = cal.road_width(all_df)
    rep["road_width_m"] = W
    fs = cal.follower_samples(all_df, clearance, W)
    st = cal.steady(fs)
    rep["following"] = {"follower_samples": int(len(fs)), "steady_samples": int(len(st)),
                        "steady_by_class": {k: int(v) for k, v in st["cls"].value_counts().items()},
                        "strip_width_m": cal.STRIP_WIDTH_M}
    # c1 = 0 sensitivity: classes whose c1 was identified get c = pooled p10/2, c1 = 0; leaders
    # (and so steady samples and T) are recomputed with that clearance.
    ident = [c for c, r in clear_rep.items() if r["c1_fit"].get("identified")]
    st_c1zero = None
    if ident:
        alt = dict(clearance)
        for c in ident:
            alt[c] = (clear_rep[c]["c_by_percentile"]["p10"], 0.0)
        st_c1zero = cal.steady(cal.follower_samples(all_df, alt, W))
    rep["c1_zero_sensitivity"] = {"classes": ident, "clearance_alt": {c: (clear_rep[c]["c_by_percentile"]["p10"], 0.0) for c in ident},
                                  "clearance_fit": {c: clearance[c] for c in ident}, "T": {}}

    # ---- lateral speed from deliberate moves
    from . import lateral as lat
    ny = position_noise(dfs, "y")
    delta = lat.hysteresis(ny["sigma_x_m"])
    ep, n_edge = lat.all_episodes(all_df, delta, ny["sigma_x_m"])
    latsum = lat.summarise(ep, CLASS_ORDER)
    rep["lateral_episodes"] = {
        "sigma_y_m": ny["sigma_x_m"], "hysteresis_m": delta,
        "dwell_speed_mps": lat.dwell_speed(ny["sigma_x_m"]),
        "sigma_vy_mps": ny["sigma_x_m"] * float(np.linalg.norm(lat.sg_weights(lat.VY_WINDOW, 1))),
        "peak_gain_by_duration": {f"{d}s": lat.sg_peak_gain(d) for d in (3, 4, 5, 6, 8)},
        "peak_gain_5pt_by_duration": {f"{d}s": lat.sg_peak_gain(d, 5) for d in (3, 4, 5, 6, 8)},
        "excluded_not_fully_observed": n_edge, "summary": latsum}

    # ---- smoothing-window sensitivity of a and b
    win = accel_window_analysis(dfs)
    rep["accel_windows"] = win

    # ---- v0, a, b, lateral
    spots = cal.spot_speeds(all_df, x_mid)
    classes = []
    T_rep, kin_rep = {}, {}
    car_T = None
    order = ["motorcycle", "car", "auto", "bus", "truck", "lcv"]
    present = [c for c in order if c in counts.index]
    # car first so other classes can fall back to it
    for c in sorted(present, key=lambda k: k != "car"):
        fr = fit[fit["cls"] == c]
        sp = spots[spots["cls"] == c]["v"]
        nveh = int(counts[c])
        enough = len(sp) >= MIN_VEHICLES
        v0 = float(np.quantile(sp, cal.V0_QUANTILE)) if enough else float(np.quantile(fr["v"], cal.V0_QUANTILE))
        a_val = float(np.quantile(fr["a"], cal.A_QUANTILE))
        b_val = -float(np.quantile(fr["a"], cal.B_QUANTILE))
        vy95 = float(np.quantile(fr["vy"].abs(), 0.95))
        kin_rep[c] = {
            "vehicles": nveh, "fit_rows": int(len(fr)), "spot_speeds": int(len(sp)),
            "v0_p85_spot": v0, "v0_p85_samples": float(np.quantile(fr["v"], 0.85)),
            "a_percentiles": {f"p{q}": float(np.quantile(fr["a"], q / 100)) for q in (1, 5, 10, 90, 95, 99)},
            "vy_abs_p95": vy95,
            "spot_speed_kmh_quantiles": [float(v) * 3.6 for v in np.quantile(sp, [0.05, 0.5, 0.85, 0.95])] if len(sp) else [],
        }
        s_c = st[st["cls"] == c]
        Tm, n_used, n_no = cal.T_median(s_c["gap"], s_c["v"], v0, cal.S0_ASSUMED)
        sens = cal.T_sensitivity(s_c["gap"], s_c["v"], v0, cal.S0_ASSUMED)
        share_no = n_no / len(s_c) if len(s_c) else math.nan
        if st_c1zero is not None:
            s_z = st_c1zero[st_c1zero["cls"] == c]
            Tz, nz, dz = cal.T_median(s_z["gap"], s_z["v"], v0, cal.S0_ASSUMED)
            rep["c1_zero_sensitivity"]["T"][c] = {"T_fit": None, "T_c1_zero": Tz, "n_used": nz,
                                                  "n_dropped": dz, "steady_samples": int(len(s_z))}
        T_rep[c] = {"T": Tm, "steady_samples": int(len(s_c)), "n_used": n_used,
                    "n_dropped_v_gt_0.9v0": n_no, "share_dropped": share_no,
                    "v0": v0, "sensitivity": sens}
        Ts = [r["T"] for r in sens if np.isfinite(r["T"])]
        if n_used >= MIN_T_SAMPLES and np.isfinite(Tm):
            T_param = cal.p(Tm, "derived",
                            f"Median of T = (s·sqrt(1-(v/v0)^4) - s0)/v over {n_used} steady-following "
                            f"samples (|a|<{cal.STEADY_MAX_ABS_A} m/s², |Δv|<{cal.STEADY_MAX_ABS_DV} m/s, "
                            f"v≥{cal.STEADY_MIN_V} m/s, gap≤{cal.STEADY_MAX_GAP:g} m; leader by the engine rule). "
                            f"CONDITIONAL on the assumed s0={cal.S0_ASSUMED:g} m and the proxy v0={v0:.2f} m/s: "
                            f"T ranges {min(Ts):.2f}-{max(Ts):.2f} s under s0±1 m, v0±10%. "
                            f"{n_no} of {len(s_c)} steady samples ({100 * share_no:.1f}%) with "
                            f"v > 0.9·v0 were excluded before inverting.")
            if c == "car":
                car_T = Tm
        else:
            fb = car_T if car_T is not None else 1.5
            T_param = cal.p(fb, "assumption",
                            f"Only {n_used} usable steady-following samples (< {MIN_T_SAMPLES}; "
                            f"{n_no} dropped with v > 0.9·v0); the car value is used.")
        size_l, size_w = _sizes(veh[veh["cls"] == c], c)
        gA, gF = cal.GAP_ACCEPTANCE[c]
        heavy = c in ("bus", "truck", "lcv")
        cl0, cl1 = clearance.get(c, (0.0, 0.0))
        crep = clear_rep.get(c, {})
        classes.append({
            "id": c, "label": cio.CLASS_LABEL[c],
            "lengthM": size_l, "widthM": size_w,
            "idm": {
                "v0": cal.p(v0, "proxy",
                            (f"85th percentile of position-derived spot speeds at x={x_mid:.1f} m "
                             f"({len(sp)} vehicles)." if enough else
                             f"85th percentile of position-derived speed samples ({len(fr)} clean samples; "
                             f"only {len(sp)} vehicles crossed x={x_mid:.1f} m cleanly, < {MIN_VEHICLES} "
                             "for a spot-speed percentile).")
                            + " Traffic is near capacity (~41 km/h), so free-flow vehicles are rare: a "
                            "proxy for the desired speed, likely an underestimate."),
                "T": T_param,
                "s0": cal.p(cal.S0_ASSUMED, "assumption",
                            "Literature default: Treiber & Kesting (2013), Traffic Flow Dynamics, "
                            "Table 11.2, IDM s0 = 2 m (city traffic). The data has almost no slow or "
                            "stopped following, so s0 is not identifiable."),
                "a": cal.p(a_val, "assumption",
                           "Informed by position-derived acceleration percentiles (p95 of "
                           f"{len(fr)} clean samples), but the value is set by the smoothing window "
                           "(9-point = 4 s quadratic Savitzky–Golay): " + _win_range(win, c, "a")
                           + ". Never the dataset's acceleration column."),
                "b": cal.p(b_val, "assumption",
                           "Informed by position-derived acceleration percentiles (minus p5 of "
                           f"{len(fr)} clean samples), but the value is set by the smoothing window "
                           "(9-point SG): " + _win_range(win, c, "b")
                           + ". Never the dataset's acceleration column."),
            },
            "clearance": {
                "c0": cal.p(cl0, "derived", _c1_c0_note(crep), nd=3) if crep.get("c1_fit", {}).get("identified")
                else cal.p(cl0, "derived",
                            f"p10 of accepted lateral gaps to side-by-side neighbours, halved (c = gap/2: "
                            f"the engine adds c on both sides). {crep.get('n', 0)} gap samples involving this "
                            f"class; c at p5/p10/p15 = " + "/".join(
                                f"{crep['c_by_percentile'][k]:.3f}" for k in ("p5", "p10", "p15")) +
                            f" m; median gap {crep.get('median_gap', math.nan):.2f} m (not used)."
                            + (f" Raw estimate {crep['c0_raw']:.3f} m < 0 (overlapping measured bodies), "
                               "clamped to 0." if crep and crep["c0_raw"] < 0 else "")
                            if crep else "no gap samples", nd=3),
                "c1": (cal.p(cl1, "derived",
                             "Slope of the per-speed-bin (2 m/s bins, ≥ 200 samples) p10 gap vs pair speed, "
                             f"halved: gap slope {crep['c1_fit']['slope_gap']:.4f} ± {crep['c1_fit']['slope_se']:.4f} "
                             f"(SE) s over a {crep['c1_fit']['speed_span']:g} m/s span. Identified by the "
                             "pre-set rule (span ≥ 6 m/s, |slope| > 2 SE, fixed before seeing the data), "
                             "but borderline. Sensitivity: with c1 forced to 0, c0 = pooled p10/2 = "
                             f"{crep['c_by_percentile']['p10']:.3f} m.", nd=4)
                       if crep.get("c1_fit", {}).get("identified") else
                       cal.p(0.0, "assumption",
                             "Speed slope not identified (" + crep.get("c1_fit", {}).get("reason", "no data")
                             + "); set to 0.")),
            },
            "gap": {
                "criticalS": cal.p(gA, "assumption", cal.GAP_NOTE.format(
                    base="4.1 s critical / 2.2 s follow-up",
                    extra="heavy-vehicle adjustment +1.0 s / +0.9 s applied." if heavy else
                    ("two-wheelers/autos in Indian traffic are reported to accept shorter gaps; "
                     "not quantified here." if c in ("motorcycle", "auto") else "car base values."))),
                "followUpS": cal.p(gF, "assumption", "See criticalS."),
            },
            "lateral": {
                "maxSpeedMps": _lat_param(latsum, rep["lateral_episodes"], c, vy95),
                "politeness": cal.p(cal.POLITENESS, "assumption",
                                    "MOBIL politeness, lower end of the typical range in Kesting, Treiber & "
                                    "Helbing (2007), Transp. Res. Rec. 1999."),
                "thresholdMps2": cal.p(cal.THRESHOLD, "assumption",
                                       "MOBIL switching threshold 0.1 m/s² (Kesting, Treiber & Helbing 2007)."),
            },
            "share": cal.p(nveh / n_veh, "derived",
                           f"{nveh} of {n_veh} vehicles in both files.", nd=4),
        })
    classes.sort(key=lambda k: order.index(k["id"]))
    rep["kinematics_by_class"] = kin_rep
    for c, r in rep["c1_zero_sensitivity"]["T"].items():
        r["T_fit"] = T_rep[c]["T"]
    # small "cars": kept as measured, flagged
    cars = veh[veh["cls"] == "car"]
    small = (cars["width"] < 1.2) | (cars["length"] < 3.0)
    big = cars[~small]
    rep["small_cars"] = {
        "n_cars": int(len(cars)), "n_small": int(small.sum()),
        "n_width_lt_1.2": int((cars["width"] < 1.2).sum()), "n_length_lt_3": int((cars["length"] < 3.0).sum()),
        "length_q_all": cal.size_quantiles(cars["length"]), "length_q_without": cal.size_quantiles(big["length"]),
        "width_q_all": cal.size_quantiles(cars["width"]), "width_q_without": cal.size_quantiles(big["width"]),
        "keys": sorted(cars.index[small].tolist()),
    }
    rep["T"] = T_rep
    classes_json = {"version": 1, "source": SOURCE, "classes": classes}

    # ---- FD
    pts = []
    for k, df in dfs.items():
        pts += d6.minute_points(df, region, d6r["files"][k]["period"], k)
    speeds = [p_["speedKmh"] for p_ in pts]
    fd = {
        "version": 1,
        "source": SOURCE,
        "method": ("Edie generalised flow, density and space-mean speed per minute over the fully "
                   "tracked region (front positions, trajectories clipped to the region)."),
        "branch": "free-flow",
        "coverage": ("FREE-FLOW BRANCH ONLY: minute space-mean speeds span "
                     f"{min(speeds):.1f}-{max(speeds):.1f} km/h. These points do not validate capacity, "
                     "congested behaviour or the effect of road width."),
        "region": {"xFromM": round(region["x_lo"], 2), "xToM": round(region["x_hi"], 2),
                   "lengthM": round(region["length_m"], 2), "roadWidthM": round(W, 2)},
        "speedRangeKmh": [round(min(speeds), 2), round(max(speeds), 2)],
        "points": pts,
    }
    return classes_json, fd, rep


WINDOWS = (5, 7, 9, 11, 15)


def _sg2_weights(n: int, dt: float = 0.5) -> np.ndarray:
    h = n // 2
    tau = np.arange(-h, h + 1) * dt
    return 2.0 * np.linalg.pinv(np.vander(tau, 3, increasing=True))[2]


def position_noise(dfs: dict[str, pd.DataFrame], col: str = "x") -> dict:
    """White position-noise level from the flat high-frequency floor of the pooled spectrum of
    position residuals (cubic fit removed; flag-free trajectories of ≥ 32 samples; Welch,
    32-sample segments). σ² = floor · fs/2, floor = median PSD at f ≥ 0.8 Hz."""
    from scipy.signal import welch
    P, n, f = None, 0, None
    for df in dfs.values():
        for _, g in df.groupby("key"):
            x = g[col].to_numpy(float)
            if len(x) < 32 or (g["flag"].to_numpy() != 0).any():
                continue
            k = np.arange(len(x))
            r = x - np.polyval(np.polyfit(k, x, 3), k)
            f, p = welch(r, fs=2.0, nperseg=32)
            P = p if P is None else P + p
            n += 1
    P = P / n
    floor = float(np.median(P[f >= 0.8]))
    return {"trajectories": n, "psd_floor_m2_per_hz": floor, "sigma_x_m": math.sqrt(floor * 1.0),
            "psd": [[float(a), float(b)] for a, b in zip(f, P)]}


def accel_window_analysis(dfs: dict[str, pd.DataFrame]) -> dict:
    """a (p95) and b (−p5) per class for quadratic Savitzky–Golay windows of 5..15 points, on
    one common sample set (flag-free within ±7 rows, so every window sees the same rows), plus
    each window's white-noise sd of a and its gain on sinusoidal accelerations of given period."""
    from .kinematics import sg
    rows_cls, est = [], {n: [] for n in WINDOWS}
    h = max(WINDOWS) // 2
    for df in dfs.values():
        for _, g in df.groupby("key"):
            x = g["x"].to_numpy(float)
            fl = (g["flag"].to_numpy() != 0).astype(float)
            ok = np.convolve(np.pad(fl, h), np.ones(2 * h + 1), "valid") == 0
            ests = {n: sg(x, n, 2) for n in WINDOWS}
            for n in WINDOWS:
                ok &= np.isfinite(ests[n])
            if not ok.any():
                continue
            rows_cls.append(g["cls"].to_numpy()[ok])
            for n in WINDOWS:
                est[n].append(ests[n][ok])
    cls = np.concatenate(rows_cls)
    A = {n: np.concatenate(est[n]) for n in WINDOWS}
    noise = position_noise(dfs)
    table = {}
    for c in CLASS_ORDER:
        m = cls == c
        if not m.any():
            continue
        table[c] = {"n": int(m.sum()), **{str(n): {"a_p95": float(np.quantile(A[n][m], 0.95)),
                                                  "b_m_p5": float(-np.quantile(A[n][m], 0.05))}
                                         for n in WINDOWS}}
    filt = {}
    for n in WINDOWS:
        c2 = _sg2_weights(n)
        k = np.arange(-(n // 2), n // 2 + 1)
        gains = {}
        for T in (8.0, 4.0, 3.0, 2.0, 1.0):
            w = 2 * math.pi / T
            gains[f"{T:g}s"] = float(abs(np.sum(c2 * -np.cos(w * k * 0.5))) / w**2)
        filt[str(n)] = {"span_s": (n - 1) * 0.5, "noise_sd_a": noise["sigma_x_m"] * float(np.linalg.norm(c2)),
                        "gain": gains}
    g = {n: filt[str(n)]["gain"] for n in WINDOWS}
    nsd = {n: filt[str(n)]["noise_sd_a"] for n in WINDOWS}
    bus5 = table.get("bus", {}).get("5", {}).get("a_p95", math.nan)
    moto5 = table.get("motorcycle", {}).get("5", {}).get("a_p95", math.nan)
    reason = (
        f"9 points (4 s). White position noise (σ_x = {noise['sigma_x_m']:.3f} m from the flat spectral "
        f"floor) adds an a-noise sd of {nsd[5]:.2f}/{nsd[7]:.2f}/{nsd[9]:.3f}/{nsd[11]:.3f}/{nsd[15]:.3f} "
        f"m/s² at 5/7/9/11/15 points. The large drop of the percentiles with window length comes from "
        f"the 2-3 s band, whose magnitude is the same for buses as for motorcycles (p95 at 5 points: "
        f"bus {bus5:.2f}, motorcycle {moto5:.2f} m/s²), which is implausible as vehicle dynamics and is "
        f"treated as tracking wobble. 9 points is the shortest window passing ≤ {100 * g[9]['3s']:.0f} % "
        f"of a 3 s oscillation (7 points: {100 * g[7]['3s']:.0f} %) while still passing "
        f"{100 * g[9]['8s']:.0f} % of an 8 s manoeuvre and {100 * g[9]['4s']:.0f} % of a 4 s one "
        f"(11 points: {100 * g[11]['4s']:.0f} %, 15 points: {100 * g[15]['4s']:.0f} % at 4 s). a and b "
        f"remain window-dependent; the table is the honest uncertainty.")
    return {"windows": list(WINDOWS), "samples": int(len(cls)), "table": table, "filter": filt,
            "position_noise": {k: v for k, v in noise.items() if k != "psd"}, "psd": noise["psd"],
            "chosen": A_WINDOW, "reason": reason}


CLASS_ORDER = ["motorcycle", "car", "auto", "bus", "truck", "lcv"]


def _win_range(win: dict, c: str, key: str) -> str:
    t = win["table"].get(c)
    if not t:
        return "n/a"
    k = "a_p95" if key == "a" else "b_m_p5"
    vals = ", ".join(f"{n} pts {t[str(n)][k]:.2f}" for n in win["windows"])
    return f"{vals} m/s² (see VALIDATION.md)"


def _lat_param(latsum: dict, info: dict, c: str, old: float) -> dict:
    r = latsum[c]
    common = (f"Peak |lateral speed| of deliberate lateral moves: episodes = monotonic lateral "
              f"displacement ≥ 1 m on 5-point SG smoothed position, reversals below the hysteresis "
              f"{info['hysteresis_m']:.3f} m (4·√2·σ_s, σ_y = {info['sigma_y_m']:.3f} m) ignored, split "
              f"at pauses ≥ 2 s with |vy| < {info['dwell_speed_mps']:.3f} m/s, fully observed only; speed by 3-point central difference (noise sd "
              f"{info['sigma_vy_mps']:.3f} m/s). ")
    if r["provenance"] == "derived":
        txt = (common + f"p85 of {r['n']} episode peaks (p75/p95 = {r['p75']:.2f}/{r['p95']:.2f} m/s); "
               f"3.5 m at this speed takes {r['time_to_cross_3p5m_s']:.1f} s. Previously "
               f"{old:.2f} m/s (p95 over all samples, mostly drift).")
    else:
        txt = (common + f"Only {r['n']} episodes for this class (< 30): pooled p85 over all "
               f"{latsum['pooled']['n']} episodes used. Previously {old:.2f} m/s.")
    return cal.p(r["value"], r["provenance"], txt)


def _c1_c0_note(crep: dict) -> str:
    f = crep["c1_fit"]
    pc = crep["c_by_percentile"]
    return (f"Intercept of c(v) = c0 + c1·v: per-speed-bin p10 of accepted lateral gaps to side-by-side "
            f"neighbours, fitted linearly in pair speed and halved (c = gap/2: the engine adds c on both "
            f"sides); gap intercept {f['intercept_gap']:.3f} m. {crep['n']} gap samples; pooled "
            f"c at p5/p10/p15 = {pc['p5']:.3f}/{pc['p10']:.3f}/{pc['p15']:.3f} m (not used because c1 is "
            f"identified); median gap {crep['median_gap']:.2f} m (not used).")


def _small_car_note(v: pd.DataFrame, col: str) -> str:
    small = (v["width"] < 1.2) | (v["length"] < 3.0)
    if not small.any():
        return ""
    q_all = cal.size_quantiles(v[col])
    q_wo = cal.size_quantiles(v.loc[~small, col])
    return (f" Kept as measured, but {int(small.sum())} 'cars' are smaller than a car (width < 1.2 m or "
            f"length < 3 m; likely misclassified two-wheelers/autos). Without them the {col} quantiles "
            f"0/5/50/95/100% would be {q_wo[0]}/{q_wo[1]}/{q_wo[10]}/{q_wo[19]}/{q_wo[20]} m instead of "
            f"{q_all[0]}/{q_all[1]}/{q_all[10]}/{q_all[19]}/{q_all[20]} m.")


def _sizes(v: pd.DataFrame, c: str) -> tuple[dict, dict]:
    out = []
    for col in ("length", "width"):
        vals = v[col]
        uniq = np.unique(vals.round(4))
        if c in ("motorcycle", "auto"):
            mode = float(vals.round(4).mode().iloc[0])
            note = (f"Constant in the dataset ({len(uniq)} distinct value(s) over {len(vals)} vehicles; "
                    f"mode {mode:g} m): a fixed size assigned by the data producers, not a measurement.")
            out.append({"kind": "fixed", "value": round(mode, 3), "provenance": "assumption", "note": note})
        else:
            out.append({"kind": "quantiles", "q": cal.size_quantiles(vals), "provenance": "derived",
                        "note": f"Quantiles 0,5,...,100% of per-vehicle {col} over {len(vals)} vehicles."
                        + (_small_car_note(v, col) if c == "car" else "")
                        + (f" {int((vals > 2.6).sum())} vehicles are measured wider than the 2.6 m legal "
                           "limit (video measurement, mirrors); kept as measured."
                           if col == "width" and (vals > 2.6).any() else "")})
    return out[0], out[1]
