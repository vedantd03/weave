"""Single entry point: `cd data-pipeline && uv run python build.py` (or
`PYTHONPATH=src uv run python -m weave_data.build`).

1. Silk Board: OSM → clip → netconvert → silkboard.json, then contract + topology checks.
2. Chennai (only if both .xlsx files are in data/chennai/): kinematics, D6, clearance, leaders,
   calibration → classes.json, chennai_fd.json. Otherwise reports that calibration is blocked.
All outputs are validated before writing; a run report goes to data-pipeline/build/report.json.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import jsonschema
import numpy as np

from . import OUT_DIR, chennai_io, netcheck, silkboard

BUILD = silkboard.BUILD_DIR
FD_SCHEMA = Path(__file__).parent / "schemas" / "chennai_fd.schema.json"


def _jsonable(o):
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def build_network() -> dict:
    net, rep = silkboard.build(BUILD / "silkboard.candidate.json")
    errs = netcheck.contract_errors(net) + netcheck.level_errors(net, silkboard.LAYER_HEIGHT_M,
                                                                 tol=LEVEL_TOL_M)
    if errs:
        raise SystemExit("silkboard.json failed checks:\n  " + "\n  ".join(errs[:50]))
    (OUT_DIR / "silkboard.json").write_text((BUILD / "silkboard.candidate.json").read_text())
    rep["stats"] = {
        "nodes": len(net["nodes"]), "links": len(net["links"]), "movements": len(net["movements"]),
        "signals": len(net["signals"]), "zones": len(net["zones"]),
        "links_by_layer": {str(k): sum(1 for lk in net["links"] if lk["layer"] == k)
                           for k in sorted({lk["layer"] for lk in net["links"]})},
    }
    return rep


# Elevation continuity tolerance at a node: link z values are exact multiples of the layer
# height (silkboard.assign_layers), so ends must match exactly.
LEVEL_TOL_M = 1e-6


def build_chennai() -> dict:
    reason = chennai_io.missing_reason()
    if reason:
        return {"status": "blocked", "reason": reason}
    from .chennai_calibration import load_all, run
    classes, fd, rep = run(load_all())
    errs = netcheck.schema_errors(classes, "classes")
    jsonschema.validate(fd, json.loads(FD_SCHEMA.read_text()))
    if errs:
        raise SystemExit("classes.json failed schema:\n  " + "\n  ".join(errs[:50]))
    (OUT_DIR / "classes.json").write_text(json.dumps(classes, indent=1, ensure_ascii=False) + "\n")
    (OUT_DIR / "chennai_fd.json").write_text(json.dumps(fd, indent=1, ensure_ascii=False) + "\n")
    rep["status"] = "done"
    return rep


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    report: dict = {}
    if "--chennai-only" not in argv:
        report["silkboard"] = build_network()
        s = report["silkboard"]["stats"]
        print(f"silkboard.json: {s}")
        for line in report["silkboard"]["patches"]:
            print(f"  patch: {line}")
        for line in report["silkboard"].get("pruned", []):
            print(f"  {line}")
    if "--network-only" not in argv:
        report["chennai"] = build_chennai()
        print(f"chennai: {report['chennai']['status']}"
              + (f" ({report['chennai']['reason']})" if report["chennai"].get("reason") else ""))
    (BUILD / "report.json").write_text(json.dumps(_jsonable(report), indent=1, ensure_ascii=False,
                                                  default=str))
    print(f"report: {BUILD / 'report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
