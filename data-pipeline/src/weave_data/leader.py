"""Strips and the leader rule: a line-by-line port of docs/MODEL.md §1.5–1.6.

This is the one rule shared with the engine (network/strips.ts, sim/leader.ts); D7 checks it
against docs/fixtures/leader_cases.json.

JS `Math.round` rounds halves up (floor(x + 0.5)); Python's `round` rounds halves to even, so
`js_round` is used for the strip count.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


@dataclass(frozen=True)
class Layout:
    n: int
    w: float


def strip_layout(road_width_m: float, target_strip_m: float) -> Layout:
    n = max(1, js_round(road_width_m / target_strip_m))
    return Layout(n, road_width_m / n)


def _clamp(k: int, n: int) -> int:
    return min(max(k, 0), n - 1)


def occupied_strips(y_centre: float, width: float, clearance: float, layout: Layout) -> tuple[int, int]:
    left = y_centre - width / 2 - clearance
    right = y_centre + width / 2 + clearance
    lo = math.floor(left / layout.w)
    hi = math.ceil(right / layout.w) - 1
    return _clamp(lo, layout.n), _clamp(hi, layout.n)


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
    left = y - width / 2 - clearance
    right = y + width / 2 + clearance
    lo = np.clip(np.floor(left / layout.w).astype(np.int64), 0, layout.n - 1)
    hi = np.clip(np.ceil(right / layout.w).astype(np.int64) - 1, 0, layout.n - 1)
    return lo, hi


def leaders_for_case(case: dict) -> dict[str, str | None]:
    """Apply the rule to one fixture case (docs/MODEL.md §1.6 fixture format)."""
    W = case["roadWidthM"]
    if case["mode"] == "lane":
        layout = strip_layout(W, W / case["lanes"])
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
