"""D7: the pipeline's leader rule reproduces the shared fixture docs/fixtures/leader_cases.json
(the same cases the engine's T8 uses), and the vectorised version agrees with the reference."""

import json

import numpy as np
import pytest

from weave_data import REPO_ROOT
from weave_data.leader import (LeaderInput, find_leaders, find_leaders_np, js_round, leaders_for_case,
                               occupied_strips, strip_layout)

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
    # MODEL §1.5 uses JS Math.round: 2.5 → 3 (Python's round would give 2)
    assert js_round(2.5) == 3 and js_round(3.5) == 4 and js_round(-0.5) == 0
    assert strip_layout(1.25, 0.5).n == 3  # 1.25/0.5 = 2.5 exactly → 3 strips
