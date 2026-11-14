"""M0 contract check: the emitted JSON Schemas exist and are valid Draft 2020-12 schemas."""

import json

import jsonschema
import pytest

from weave_data import SCHEMA_DIR


@pytest.mark.parametrize("name", ["network", "classes", "scenario"])
def test_emitted_schema_is_valid(name: str) -> None:
    path = SCHEMA_DIR / f"{name}.schema.json"
    assert path.exists(), f"run `pnpm emit-schema` to produce {path}"
    schema = json.loads(path.read_text())
    jsonschema.Draft202012Validator.check_schema(schema)


def test_minimal_network_validates_against_emitted_schema() -> None:
    schema = json.loads((SCHEMA_DIR / "network.schema.json").read_text())
    net = {
        "version": 1,
        "id": "t",
        "name": "t",
        "nodes": [
            {"id": "a", "x": 0, "y": 0, "kind": "boundary"},
            {"id": "b", "x": 100, "y": 0, "kind": "boundary"},
        ],
        "links": [
            {"id": "l", "from": "a", "to": "b", "polyline": [[0, 0], [100, 0]],
             "widthM": 7.0, "lanes": 2, "speedLimitMps": 14.0}
        ],
    }
    jsonschema.validate(net, schema)
    net["links"][0]["widthM"] = -1
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(net, schema)
