"""D8 (lateral): deliberate lateral moves embedded in noise are detected, sub-threshold
wiggles are not, and each move's peak lateral speed is recovered within a derived bound."""

import math

import numpy as np
import pandas as pd
import pytest

from weave_data import lateral as L

DT = 0.5


def raised_cosine_move(t, t0, D, tau):
    """Lateral displacement of a move starting at t0: vy = (D/τ)(1 − cos 2π(t−t0)/τ), peak 2D/τ."""
    u = np.clip(t - t0, 0.0, tau)
    return D * (u / tau - np.sin(2 * math.pi * u / tau) / (2 * math.pi))


def build(sigma, rng):
    t = np.arange(0.0, 120.0, DT)
    y = np.full_like(t, 3.0)
    moves = [(10.0, 1.5, 4.0), (35.0, 3.5, 6.0), (60.0, -2.5, 5.0), (95.0, 1.2, 8.0)]
    for t0, D, tau in moves:
        y += raised_cosine_move(t, t0, D, tau)
    # sub-threshold wiggle between moves: 0.6 m peak to peak, never a 1 m monotonic move
    y += np.where((t > 75) & (t < 90), 0.3 * np.sin(2 * math.pi * (t - 75) / 5.0), 0.0)
    return t, y + rng.normal(0.0, sigma, len(t)), moves


def test_moves_detected_and_peaks_recovered():
    sigma = 0.03  # m, about twice the lateral noise found in the Chennai data
    rng = np.random.default_rng(42)
    for _ in range(50):
        t, y, moves = build(sigma, rng)
        eps, edge = L.episodes(t, y, L.hysteresis(sigma))
        assert edge == 0
        assert len(eps) == len(moves), eps
        eps = sorted(eps, key=lambda e: e["t0"])
        for e, (t0, D, tau) in zip(eps, moves):
            assert np.sign(e["disp"]) == np.sign(D)
            # displacement: a move is cut where its smoothed speed falls below the dwell speed
            # v_th = 4σ‖c₁(5)‖; the raised-cosine tail below v_th at each end holds D·F(u*), with
            # 1 − cos 2πu* = v_th·τ/|D| and F(u) = u − sin(2πu)/2π. The two end positions carry
            # smoothed noise (sd σ‖c₀(5)‖ each; 4 sd of their difference).
            h = np.arange(-2, 3) * DT
            P = np.linalg.pinv(np.vander(h, 3, increasing=True))
            v_th = 4 * sigma * np.linalg.norm(P[1])
            u = math.acos(1 - v_th * tau / abs(D)) / (2 * math.pi)
            tail = abs(D) * (u - math.sin(2 * math.pi * u) / (2 * math.pi))
            tol = 2 * tail + 4 * math.sqrt(2) * sigma * np.linalg.norm(P[0])
            assert abs(abs(e["disp"]) - abs(D)) <= tol
            peak = 2 * abs(D) / tau
            # 3-point central difference at the peak: gain g = (1 + sin θ / θ)/2, θ = 2πΔt/τ
            th = 2 * math.pi * DT / tau
            g = (1 + math.sin(th) / th) / 2
            # the sampled maximum may sit up to Δt/2 from the peak; the filtered profile is a
            # raised cosine there too, so it drops by at most ½(2π·0.25/τ)² relative
            samp = 0.5 * (2 * math.pi * (DT / 2) / tau) ** 2
            # noise of the central difference: σ_v = √2·σ/(2Δt); 4.5 σ_v covers the max over the
            # few samples near the peak with overwhelming probability
            sv = math.sqrt(2) * sigma / (2 * DT)
            lo = g * peak * (1 - samp) - 4.5 * sv
            hi = g * peak + 4.5 * sv
            assert lo <= e["peak"] <= hi, (e, peak, lo, hi)


def test_no_episode_in_pure_noise_or_drift():
    rng = np.random.default_rng(7)
    sigma = 0.03
    t = np.arange(0.0, 120.0, DT)
    y = 5.0 + 0.4 * np.sin(2 * math.pi * t / 20.0) + rng.normal(0, sigma, len(t))  # 0.8 m p-p drift
    eps, _ = L.episodes(t, y, L.hysteresis(sigma))
    assert eps == []


def test_turning_points_hysteresis():
    # reversals smaller than delta are ignored; larger ones split the run
    y = np.array([0.0, 0.5, 0.45, 1.2, 1.1, 0.2, 0.25, 0.0])
    assert L.turning_points(y, 0.2) == [0, 3, 7]


def test_summary_explicit_per_class_mapping():
    # user decision: own p85 for motorcycle, car, auto, bus (bus even below 30 episodes);
    # truck borrows bus, lcv borrows car, both labelled 'assumption'
    rng = np.random.default_rng(3)
    n = {"motorcycle": 60, "car": 40, "auto": 35, "bus": 18, "truck": 1, "lcv": 6}
    peaks = {c: rng.uniform(0.3, 1.2, k) for c, k in n.items()}
    ep = pd.DataFrame({"cls": np.concatenate([[c] * k for c, k in n.items()]),
                       "peak": np.concatenate(list(peaks.values())),
                       "disp": 1.5, "duration": 6.0, "duration_10_90": 4.0})
    s = L.summarise(ep, list(n))
    for c in ("motorcycle", "car", "auto", "bus"):
        assert s[c]["provenance"] == "derived"
        assert s[c]["value"] == np.quantile(peaks[c], 0.85)
        assert s[c]["n"] == n[c]
    assert s["bus"]["small_sample"] and not s["car"]["small_sample"]
    assert s["truck"]["provenance"] == "assumption" and s["truck"]["value"] == np.quantile(peaks["bus"], 0.85)
    assert s["lcv"]["provenance"] == "assumption" and s["lcv"]["value"] == np.quantile(peaks["car"], 0.85)
    for c in n:
        assert s[c]["time_to_cross_3p5m_s"] == 3.5 / s[c]["value"]


def test_summary_missing_source_and_chained_mapping():
    ep = pd.DataFrame({"cls": ["car"] * 3, "peak": [0.5, 0.6, 0.7], "disp": 1.5,
                       "duration": 6.0, "duration_10_90": 4.0})
    # a class whose source has no episodes gets no value (the caller falls back), not a guess
    s = L.summarise(ep, ["car", "bus", "truck"], {"car": "own", "bus": "own", "truck": "bus"})
    assert s["bus"]["value"] is None and s["truck"]["value"] is None
    assert s["car"]["value"] == np.quantile([0.5, 0.6, 0.7], 0.85)
    with pytest.raises(ValueError):
        L.summarise(ep, ["car", "bus", "lcv"], {"car": "own", "bus": "lcv", "lcv": "car"})  # chain


def test_partly_observed_moves_are_excluded_and_reported():
    # a move that runs into the end of the stretch is not used, but is reported with its peak
    sigma = 0.03
    t = np.arange(0.0, 30.0, DT)
    y = 3.0 + raised_cosine_move(t, 24.0, 2.0, 6.0) + np.random.default_rng(1).normal(0, sigma, len(t))
    ex = []
    eps, edge = L.episodes(t, y, L.hysteresis(sigma), sigma_y=sigma, excluded=ex)
    assert eps == [] and edge == 1 and len(ex) == 1
    assert ex[0]["dist_to_end"] == min(ex[0]["peak_index"], len(t) - 1 - ex[0]["peak_index"])
