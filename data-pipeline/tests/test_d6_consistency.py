"""D6: kinematic and macroscopic consistency.

Part 1 (always runs): the D6 machinery on synthetic trajectories with analytic answers.
Part 2 (real data): skipped with an explicit reason until the user places the two Chennai
files in data/chennai/. Every expected number traces to the paper (6,010 veh/h) or is
computed here. The paper's 123.5 veh/km is NOT an expected value (6,010 / 123.5 = 48.7 km/h
contradicts the paper's own speeds) and the earlier 128 veh/km figure is not used at all.
"""

import math

import numpy as np
import pandas as pd
import pytest

from weave_data import chennai_io as cio
from weave_data import d6


# ------------------------------------------------------------------ part 1: synthetic theory

def uniform_stream(v=10.0, h=2.0, n=400, x_start=0.0, x_end=300.0, dt=0.5):
    """Vehicles at constant speed v entering x=0 every h seconds; tracked on [x_start, x_end]."""
    rows = []
    grid = np.arange(0, n * h + x_end / v + 10, dt)
    for i in range(n):
        t0 = i * h
        tt = grid[grid >= t0]
        x = v * (tt - t0)
        m = (x >= x_start) & (x <= x_end)
        for t, xx in zip(tt[m], x[m]):
            rows.append({"key": f"s:{i}", "t": t, "x": xx})
    return pd.DataFrame(rows)


def test_edie_and_line_counts_match_theory():
    v, h = 10.0, 2.0
    df = uniform_stream(v, h)
    e = d6.edie(df, 50.0, 250.0, 100.0, 500.0)
    # stationary stream: q = 1/h, k = 1/(h·v), v_s = v
    assert e["flow_vph"] == pytest.approx(3600 / h, rel=1e-9)
    assert e["density_vpkm"] == pytest.approx(1000 / (h * v), rel=1e-9)
    assert e["speed_kmh"] == pytest.approx(v * 3.6, rel=1e-9)


def test_tracked_region_excludes_ragged_ends():
    rng = np.random.default_rng(3)
    df = uniform_stream()
    # tracking starts somewhere in the first 20 m and ends in the last 20 m
    start = {k: rng.uniform(0, 20) for k in df["key"].unique()}
    end = {k: rng.uniform(280, 300) for k in df["key"].unique()}
    df = df[(df["x"] >= df["key"].map(start)) & (df["x"] <= df["key"].map(end))]
    r = d6.tracked_region(df)
    # samples lie on multiples of v·dt = 5 m, so the first observed position is the next
    # multiple of 5 above U(0,20): it equals 20 m with probability 1/4 ≫ 1 %, so the 99th
    # percentile is exactly 20 m; symmetrically the 1st percentile of last positions is 280 m.
    assert r["x_lo"] == pytest.approx(20.0, abs=1e-9)
    assert r["x_hi"] == pytest.approx(280.0, abs=1e-9)


def test_vehicles_present_at_file_start_do_not_shift_region():
    # recording starts at t = 100 s: 300/(v·h) = 15 vehicles (≈4 % of the ~350) are first seen
    # mid-section at that instant; they must not count as "tracking starts here"
    df = uniform_stream(v=10.0, h=2.0)
    df = df[df["t"] >= 100.0].assign(file="A")
    r = d6.tracked_region(df)
    assert r["x_lo"] == pytest.approx(0.0, abs=1e-9)
    assert r["x_hi"] == pytest.approx(300.0, abs=1e-9)


def test_density_bound_holds_on_synthetic():
    df = uniform_stream(v=9.0, h=1.7)
    region = d6.tracked_region(df)
    res = d6.file_d6(df, region)
    assert abs(res["density_diff_vpkm"]) <= res["density_bound_vpkm"] + 1e-9


# ------------------------------------------------------------------ part 2: the real data

@pytest.fixture(scope="module")
def real():
    reason = cio.missing_reason()
    if reason:
        pytest.skip(reason)
    from weave_data.chennai_calibration import load_all
    dfs = load_all()
    return dfs, d6.analyse(dfs)


def test_real_tracked_region_inside_section(real):
    _, res = real
    r = res["region"]
    lo, hi = r["section_x_range"]
    assert lo < r["x_lo"] < r["x_hi"] < hi
    assert r["fraction_spanning"] >= 0.95


def test_real_line_count_flow_vs_paper(real):
    _, res = real
    tot = res["total"]
    # tolerance computed in d6.combine: 3·sqrt(sd_poisson² + sd_lines²)
    assert abs(tot["flow_lines_vph"] - d6.PAPER_FLOW_VPH) <= tot["flow_tolerance_vph"], tot


def test_real_speed_ratio_stable_and_not_one(real):
    dfs, _ = real
    sr = d6.speed_ratio(pd.concat(dfs.values(), ignore_index=True))
    r = sr["median_ratio"]
    half_iqr = (sr["iqr"][1] - sr["iqr"][0]) / 2
    medians = [v for g in sr["groups"].values() for v in g.values()]
    max_dev = max(abs(m - r) for m in medians)
    # stable: grouping by class, file or speed bin moves the median by less than half the
    # per-sample interquartile spread of the ratio
    assert max_dev < half_iqr, sr
    # clearly ≠ 1: every group median is on the same side of 1, and |r − 1| exceeds three
    # times the largest group deviation
    assert all(m > 1 for m in medians) or all(m < 1 for m in medians), sr
    assert abs(r - 1) > 3 * max_dev, sr


def test_real_edie_density_matches_flow_over_speed(real):
    _, res = real
    for k, f in res["files"].items():
        assert abs(f["density_diff_vpkm"]) <= f["density_bound_vpkm"], (k, f)
    tot = res["total"]
    assert abs(tot["density_diff_vpkm"]) <= tot["density_bound_vpkm"], tot


def test_paper_density_inconsistency_recorded():
    # recorded for VALIDATION.md, not used as an expected value
    assert d6.PAPER_FLOW_VPH / d6.PAPER_DENSITY_VPK == pytest.approx(48.66, abs=0.01)
