"""D5: schema validity of every output.

* silkboard.json: emitted network schema + zod cross-reference rules (Python port).
* classes.json / chennai_fd.json: validated when present (they exist only after the Chennai
  calibration has run on the real files).
* The calibration code path is also run end-to-end on synthetic Chennai-shaped data, and its
  outputs must validate, so the code is exercised before the real files arrive.
"""

import json
from pathlib import Path

import jsonschema
import pytest

from synth import traffic
from weave_data import OUT_DIR, chennai_io, netcheck
from weave_data.chennai_calibration import run
from weave_data.kinematics import add_kinematics

FD_SCHEMA = json.loads((Path(netcheck.__file__).parent / "schemas" / "chennai_fd.schema.json").read_text())


def test_silkboard_valid():
    net = json.loads((OUT_DIR / "silkboard.json").read_text())
    assert netcheck.contract_errors(net) == []


def _real_output(name: str) -> dict:
    p = OUT_DIR / name
    if not p.exists():
        reason = chennai_io.missing_reason()
        if reason:
            pytest.skip(f"{name} not built yet: {reason}")
        pytest.fail(f"{name} missing although the Chennai files are present: run build.py")
    return json.loads(p.read_text())


def test_classes_json_valid():
    classes = _real_output("classes.json")
    assert netcheck.schema_errors(classes, "classes") == []
    assert len({c["id"] for c in classes["classes"]}) == len(classes["classes"])


def test_chennai_fd_valid():
    jsonschema.validate(_real_output("chennai_fd.json"), FD_SCHEMA)


@pytest.fixture(scope="module")
def synthetic_run():
    dfs = {k: add_kinematics(chennai_io.normalise(traffic(seed), k))
           for seed, k in ((1, "2.45-3.00"), (2, "3.00-3.15"))}
    return run(dfs)


def test_synthetic_calibration_outputs_validate(synthetic_run):
    classes, fd, rep = synthetic_run
    assert netcheck.schema_errors(classes, "classes") == []
    jsonschema.validate(fd, FD_SCHEMA)
    assert {c["id"] for c in classes["classes"]} == set(chennai_io.CLASS_BY_CODE.values())


def test_synthetic_provenance_rules(synthetic_run):
    classes, _, _ = synthetic_run
    for c in classes["classes"]:
        assert c["idm"]["v0"]["provenance"] == "proxy"
        assert c["idm"]["s0"]["provenance"] == "assumption"
        assert c["idm"]["a"]["provenance"] == "derived"
        assert c["idm"]["b"]["provenance"] == "derived"
        assert c["share"]["provenance"] == "derived"
        if c["id"] in ("motorcycle", "auto"):
            assert c["lengthM"]["kind"] == "fixed" and c["lengthM"]["provenance"] == "assumption"
            assert c["widthM"]["kind"] == "fixed" and c["widthM"]["provenance"] == "assumption"
        else:
            assert c["lengthM"]["kind"] == "quantiles" and len(c["lengthM"]["q"]) == 21
            assert c["lengthM"]["provenance"] == "derived"
        for group in ("idm", "clearance", "gap", "lateral"):
            for prm in c[group].values():
                assert prm["note"]
    assert abs(sum(c["share"]["value"] for c in classes["classes"]) - 1) < 1e-3


def test_synthetic_speed_ratio_recovered(synthetic_run):
    # the synthetic speed column is the true speed / 1.92 (set in synth.traffic); the
    # position-derived ratio must recover that factor, which the code never sees.
    # Tolerance: the quadratic Savitzky-Golay slope at a window centre has bias
    # x3(t)·(Σk⁴/Σk²)·dt²/6, x3 = third derivative (Taylor expansion of the least-squares
    # slope). In synth.traffic |x3| = |A·ω·cos| ≤ 0.5·0.6 and v ≥ 9 − 2·0.5/0.2 = 4 m/s, so the
    # relative error of any sample's speed is at most bias / 4 m/s; the median inherits it.
    k = range(-2, 3)  # V_WINDOW = 5
    bias = 0.5 * 0.6 * sum(i**4 for i in k) / sum(i**2 for i in k) * 0.5**2 / 6
    tol = 1.92 * bias / 4.0
    _, _, rep = synthetic_run
    assert abs(rep["speed_ratio"]["median_ratio"] - 1.92) <= tol
