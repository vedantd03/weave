"""Chennai calibration run: raw files → kinematics → D6 → clearance → leaders → T, a, b, v0,
sizes, shares → classes.json and chennai_fd.json (+ a JSON report for VALIDATION.md)."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import calibrate as cal
from . import chennai_io as cio
from . import d6
from .kinematics import add_kinematics, check_summary, fit_rows

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
                        "steady_by_class": {k: int(v) for k, v in st["cls"].value_counts().items()}}

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
        T_rep[c] = {"T": Tm, "n_used": n_used, "n_no_equilibrium": n_no, "sensitivity": sens}
        Ts = [r["T"] for r in sens if np.isfinite(r["T"])]
        if n_used >= MIN_T_SAMPLES and np.isfinite(Tm):
            T_param = cal.p(Tm, "derived",
                            f"Median of T = (s·sqrt(1-(v/v0)^4) - s0)/v over {n_used} steady-following "
                            f"samples (|a|<{cal.STEADY_MAX_ABS_A} m/s², |Δv|<{cal.STEADY_MAX_ABS_DV} m/s, "
                            f"v≥{cal.STEADY_MIN_V} m/s, gap≤{cal.STEADY_MAX_GAP:g} m; leader by the engine rule). "
                            f"CONDITIONAL on the assumed s0={cal.S0_ASSUMED:g} m and the proxy v0={v0:.2f} m/s: "
                            f"T ranges {min(Ts):.2f}-{max(Ts):.2f} s under s0±1 m, v0±10% "
                            f"({n_no} samples with v≥v0 have no equilibrium and are excluded).")
            if c == "car":
                car_T = Tm
        else:
            fb = car_T if car_T is not None else 1.5
            T_param = cal.p(fb, "assumption",
                            f"Only {n_used} steady-following samples (< {MIN_T_SAMPLES}); car value used.")
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
                            f"85th percentile of position-derived spot speeds at x={x_mid:.1f} m "
                            f"({len(sp)} vehicles). Traffic is near capacity (~41 km/h), so free-flow "
                            "vehicles are rare: a proxy for the desired speed, likely an underestimate."),
                "T": T_param,
                "s0": cal.p(cal.S0_ASSUMED, "assumption",
                            "Literature default: Treiber & Kesting (2013), Traffic Flow Dynamics, "
                            "Table 11.2, IDM s0 = 2 m (city traffic). The data has almost no slow or "
                            "stopped following, so s0 is not identifiable."),
                "a": cal.p(a_val, "derived",
                           f"95th percentile of position-derived longitudinal acceleration "
                           f"({len(fr)} clean samples; Savitzky–Golay, 4 s quadratic window). "
                           "Never the dataset's acceleration column."),
                "b": cal.p(b_val, "derived",
                           "Minus the 5th percentile of position-derived longitudinal acceleration "
                           f"({len(fr)} clean samples). Never the dataset's acceleration column."),
            },
            "clearance": {
                "c0": cal.p(cl0, "derived",
                            f"p10 of accepted lateral gaps to side-by-side neighbours, halved (c = gap/2: "
                            f"the engine adds c on both sides). {crep.get('n', 0)} gap samples involving this "
                            f"class; c at p5/p10/p15 = " + "/".join(
                                f"{crep['c_by_percentile'][k]:.3f}" for k in ("p5", "p10", "p15")) +
                            f" m; median gap {crep.get('median_gap', math.nan):.2f} m (not used)."
                            + (f" Raw estimate {crep['c0_raw']:.3f} m < 0 (overlapping measured bodies), "
                               "clamped to 0." if crep and crep["c0_raw"] < 0 else "")
                            if crep else "no gap samples", nd=3),
                "c1": (cal.p(cl1, "derived", "Slope of the per-speed-bin p10 gap, halved.", nd=4)
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
                "maxSpeedMps": cal.p(vy95, "derived",
                                     "95th percentile of |position-derived lateral speed| (2 s quadratic "
                                     "Savitzky–Golay), clean samples."),
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
                        "note": f"Quantiles 0,5,...,100% of per-vehicle {col} over {len(vals)} vehicles."})
    return out[0], out[1]
