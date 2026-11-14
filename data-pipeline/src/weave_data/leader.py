"""Strips and the leader rule: a line-by-line port of docs/MODEL.md §1.5–1.6.

This is the one rule shared with the engine (network/strips.ts, sim/leader.ts); D7 checks it
against docs/fixtures/leader_cases.json.

Strip mode uses the M2 grid: fixed strip width Δ anchored at the left edge (origin offset o,
0 for a road section), last strip possibly partial, with 1e-9 boundary tolerances.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


def js_round(x: float) -> int:
    """JS Math.round (half-up). Used for the lane-mode movement strip count (MODEL §1.5)."""
    return math.floor(x + 0.5)


EPS = 1e-9


@dataclass(frozen=True)
class Layout:
    """n strips of width w (Δ) on a grid anchored at the left edge, shifted by o ∈ [0, Δ)."""
    n: int
    w: float
    o: float = 0.0


def strip_layout(road_width_m: float, strip_m: float, origin_m: float = 0.0) -> Layout:
    """MODEL §1.5 (revised in M2): fixed strip width Δ, grid anchored at the left edge.
    n = (o > 0 ? 1 : 0) + ceil((W − o)/Δ − 1e-9), n ≥ 1; the last strip may be partial."""
    o = origin_m % strip_m
    if o < EPS or strip_m - o < EPS:
        o = 0.0
    n = (1 if o > 0 else 0) + math.ceil((road_width_m - o) / strip_m - EPS)
    return Layout(max(1, n), strip_m, o)


def lane_layout(road_width_m: float, lanes: int) -> Layout:
    return Layout(lanes, road_width_m / lanes, 0.0)


def _clamp(k: int, n: int) -> int:
    return min(max(k, 0), n - 1)


def strip_index(x: float, layout: Layout) -> int:
    shift = 1 if layout.o > 0 else 0
    return _clamp(math.floor((x - layout.o) / layout.w + EPS) + shift, layout.n)


def occupied_strips(y_centre: float, width: float, clearance: float, layout: Layout) -> tuple[int, int]:
    left = y_centre - width / 2 - clearance
    right = y_centre + width / 2 + clearance
    shift = 1 if layout.o > 0 else 0
    lo = strip_index(left, layout)
    hi = _clamp(math.ceil((right - layout.o) / layout.w - EPS) - 1 + shift, layout.n)
    return lo, hi


def swept_strips(y_a: float, y_b: float, width: float, clearance: float, layout: Layout) -> tuple[int, int]:
    a = occupied_strips(y_a, width, clearance, layout)
    b = occupied_strips(y_b, width, clearance, layout)
    return min(a[0], b[0]), max(a[1], b[1])


def lane_strip(y_centre: float, layout: Layout) -> tuple[int, int]:
    k = _clamp(math.floor(y_centre / layout.w), layout.n)
    return k, k


@dataclass(frozen=True)
class LeaderInput:
    front: float
    length: float
    lo: int
    hi: int


def find_leaders(vs: Sequence[LeaderInput]) -> list[int]:
    """Reference implementation (O(n²)): leader index for each vehicle, or −1."""
    out = []
    for i, vi in enumerate(vs):
        best, best_rear = -1, math.inf
        for j, vj in enumerate(vs):
            if j == i:
                continue
            if not (vj.lo <= vi.hi and vi.lo <= vj.hi):
                continue
            if not (vj.front > vi.front or (vj.front == vi.front and j > i)):
                continue
            rear = vj.front - vj.length
            if rear < best_rear:  # strict: ties keep the smaller index (scanned first)
                best, best_rear = j, rear
        out.append(best)
    return out


def find_leaders_np(front: np.ndarray, length: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Vectorised equivalent of `find_leaders` for one time step."""
    n = len(front)
    if n == 0:
        return np.zeros(0, np.int64)
    idx = np.arange(n)
    overlap = (lo[None, :] <= hi[:, None]) & (lo[:, None] <= hi[None, :])
    ahead = (front[None, :] > front[:, None]) | (
        (front[None, :] == front[:, None]) & (idx[None, :] > idx[:, None]))
    cand = overlap & ahead
    np.fill_diagonal(cand, False)
    rear = np.where(cand, (front - length)[None, :], np.inf)
    j = np.argmin(rear, axis=1)  # first index of the minimum → ties to the smaller index
    return np.where(cand.any(axis=1), j, -1)


def occupied_np(y: np.ndarray, width: np.ndarray, clearance: np.ndarray, layout: Layout):
    """Vectorised `occupied_strips` (same operation order and tolerances)."""
    left = y - width / 2 - clearance
    right = y + width / 2 + clearance
    shift = 1 if layout.o > 0 else 0
    lo = np.clip(np.floor((left - layout.o) / layout.w + EPS).astype(np.int64) + shift, 0, layout.n - 1)
    hi = np.clip(np.ceil((right - layout.o) / layout.w - EPS).astype(np.int64) - 1 + shift, 0, layout.n - 1)
    return lo, hi


def leaders_for_case(case: dict) -> dict[str, str | None]:
    """Apply the rule to one fixture case (docs/MODEL.md §1.6 fixture format)."""
    W = case["roadWidthM"]
    if case["mode"] == "lane":
        layout = lane_layout(W, case["lanes"])
    else:
        layout = strip_layout(W, case["stripWidthM"])
    inputs = []
    for v in case["vehicles"]:
        if case["mode"] == "lane":
            lo, hi = lane_strip(v["centreM"], layout)
        else:
            lo, hi = occupied_strips(v["centreM"], v["widthM"], v["clearanceM"], layout)
        inputs.append(LeaderInput(v["frontM"], v["lengthM"], lo, hi))
    ld = find_leaders(inputs)
    ids = [v["id"] for v in case["vehicles"]]
    return {ids[i]: (ids[j] if j >= 0 else None) for i, j in enumerate(ld)}
