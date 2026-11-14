"""D7: the pipeline's leader rule reproduces the shared fixture docs/fixtures/leader_cases.json
(the same cases the engine's T8 uses), and the vectorised version agrees with the reference."""

import json

import numpy as np
import pytest

from weave_data import REPO_ROOT
from weave_data.leader import (LeaderInput, find_leaders, find_leaders_np, js_round, leaders_for_case,
                               occupied_np, occupied_strips, strip_index, strip_layout)

FIXTURE = REPO_ROOT / "docs" / "fixtures" / "leader_cases.json"


def _cases():
    if not FIXTURE.exists():
        return []
    return json.loads(FIXTURE.read_text())["cases"]


@pytest.fixture(scope="module")
def cases():
    if not FIXTURE.exists():
        pytest.skip(f"{FIXTURE} not written yet (owned by the test-author agent)")
    return _cases()


def test_fixture_has_cases(cases):
    assert len(cases) > 0


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_fixture_case(case):
    got = leaders_for_case(case)
    want = {str(k): v for k, v in case["expected"].items()}
    got = {str(k): v for k, v in got.items()}
    assert got == want, case.get("why", "")


@pytest.mark.parametrize("case", [c for c in _cases() if c["mode"] == "strip"],
                         ids=lambda c: c["name"])
def test_vectorised_matches_reference_on_fixture(case):
    # the vectorised finder is used on the data in strip mode only
    W = case["roadWidthM"]
    lay = strip_layout(W, case["stripWidthM"])
    vs = case["vehicles"]
    los, his = zip(*[occupied_strips(v["centreM"], v["widthM"], v["clearanceM"], lay) for v in vs])
    ref = find_leaders([LeaderInput(v["frontM"], v["lengthM"], lo, hi) for v, lo, hi in zip(vs, los, his)])
    vec = find_leaders_np(np.array([v["frontM"] for v in vs], float),
                          np.array([v["lengthM"] for v in vs], float), np.array(los), np.array(his))
    assert list(vec) == ref


def test_vectorised_matches_reference_random():
    rng = np.random.default_rng(7)
    for _ in range(300):
        n = int(rng.integers(1, 25))
        front = np.round(rng.uniform(0, 60, n), 0)  # rounding creates equal-front ties
        length = rng.choice([2.0, 4.0, 12.0], n)
        lo = rng.integers(0, 20, n)
        hi = lo + rng.integers(0, 6, n)
        ref = find_leaders([LeaderInput(*a) for a in zip(front, length, lo, hi)])
        assert list(find_leaders_np(front, length, lo, hi)) == ref


def test_js_round_halves_up():
    # MODEL §1.2/§1.5 "round" is JS Math.round (half-up): 2.5 → 3 (Python's round gives 2).
    # Since M2 it is only used for the lane-mode movement strip count.
    assert js_round(2.5) == 3 and js_round(3.5) == 4 and js_round(-0.5) == 0


# ---- MODEL §1.5 (revised in M2): fixed Δ, grid anchored at the left edge, origin offset o.
# Expected values below are worked by hand from the spec formulas.

def test_layout_fixed_width_with_partial_last_strip():
    lay = strip_layout(7.0, 0.25)          # 7/0.25 = 28 exactly → 28 full strips
    assert (lay.n, lay.w, lay.o) == (28, 0.25, 0.0)
    lay = strip_layout(7.1, 0.25)          # 28 full strips + one 0.1 m strip
    assert lay.n == 29
    assert strip_layout(0.1, 0.25).n == 1  # narrower than one strip → n ≥ 1


def test_occupancy_boundaries_and_tolerance():
    lay = strip_layout(7.0, 0.25)
    # body [0.5, 1.0): left on boundary 0.5 → strip 2; right on boundary 1.0 → last strip is 3
    assert occupied_strips(0.75, 0.5, 0.0, lay) == (2, 3)
    # right edge 1e-12 past a boundary still counts as on it (1e-9 tolerance)
    assert occupied_strips(0.75, 0.5 + 2e-12, 0.0, lay) == (2, 3)
    # right edge clearly inside strip 4 ([1.0, 1.25))
    assert occupied_strips(0.8, 0.5, 0.0, lay) == (2, 4)
    # clamping at both edges
    assert occupied_strips(0.1, 1.0, 0.2, lay) == (0, 3)
    assert occupied_strips(6.9, 1.0, 0.2, lay) == (24, 27)


def test_origin_offset_grid():
    # o = 0.1, Δ = 0.25, W = 1.0: boundaries 0 | 0.1 | 0.35 | 0.6 | 0.85 | 1.0 → n = 1 + ceil(0.9/0.25) = 5
    lay = strip_layout(1.0, 0.25, 0.1)
    assert lay.n == 5 and lay.o == pytest.approx(0.1)
    assert [strip_index(x, lay) for x in (0.05, 0.1, 0.34, 0.35, 0.9)] == [0, 1, 1, 2, 4]
    # body [0.35, 0.6) sits exactly on strip 2
    assert occupied_strips(0.475, 0.25, 0.0, lay) == (2, 2)
    # offsets within 1e-9 of 0 or Δ count as 0; the offset is taken mod Δ
    assert strip_layout(1.0, 0.25, 0.25 - 1e-12).o == 0.0
    assert strip_layout(1.0, 0.25, 0.6).o == pytest.approx(0.1)


def test_vectorised_occupancy_matches_scalar():
    rng = np.random.default_rng(3)
    for o in (0.0, 0.1):
        lay = strip_layout(11.07, 0.25, o)
        # mix of random and boundary-aligned edges
        y = np.r_[rng.uniform(0, 11.07, 400), np.arange(1, 40) * 0.25 + 0.3]
        w = np.r_[rng.choice([0.6, 1.4, 1.7, 2.5], 400), np.full(39, 0.6)]
        c = np.r_[rng.uniform(0, 0.4, 400), np.zeros(39)]
        lo, hi = occupied_np(y, w, c, lay)
        ref = [occupied_strips(a, b, d, lay) for a, b, d in zip(y, w, c)]
        assert list(zip(lo.tolist(), hi.tolist())) == ref
