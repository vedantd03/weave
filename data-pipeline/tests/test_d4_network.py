"""D4: Silk Board network topology, and the Python port of the zod cross-reference rules.

The network is rebuilt from data/osm/silkboard.osm + patches in a temporary location (so the
test also proves the committed apps/web/public/data/silkboard.json is reproducible)."""

import copy
import json
import math

import pytest

from weave_data import OUT_DIR, netcheck, silkboard
from weave_data.osm_clip import way_tags


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("net") / "silkboard.json"
    net, rep = silkboard.build(out)
    return net, rep


def test_committed_output_is_reproducible(built):
    net, _ = built
    committed = OUT_DIR / "silkboard.json"
    assert committed.exists(), "run `uv run python build.py`"
    assert json.loads(committed.read_text()) == net


def test_contract_and_crossrefs(built):
    net, _ = built
    assert netcheck.contract_errors(net) == []


def test_every_movement_joins_links_at_its_node(built):
    net, _ = built
    links = {lk["id"]: lk for lk in net["links"]}
    for m in net["movements"]:
        assert links[m["fromLink"]]["to"] == m["node"]
        assert links[m["toLink"]]["from"] == m["node"]
        assert len(m["path"]) >= 2


def test_movement_paths_start_and_end_on_their_links(built):
    # path ends must lie within half a carriageway width of the link end/start centreline point
    net, _ = built
    links = {lk["id"]: lk for lk in net["links"]}
    for m in net["movements"]:
        f, t = links[m["fromLink"]], links[m["toLink"]]
        assert math.dist(m["path"][0], f["polyline"][-1]) <= f["widthM"] / 2 + 0.05
        assert math.dist(m["path"][-1], t["polyline"][0]) <= t["widthM"] / 2 + 0.05


def test_lateral_bands_inside_links(built):
    net, _ = built
    links = {lk["id"]: lk for lk in net["links"]}
    for m in net["movements"]:
        for band, lk in ((m["fromLateral"], links[m["fromLink"]]), (m["toLateral"], links[m["toLink"]])):
            assert 0 <= band[0] < band[1] <= lk["widthM"] + 1e-9


def test_sumo_lane_zero_is_leftmost_in_lefthand_network(built):
    # measured from lane geometry; documents the SUMO index → left-edge mapping
    _, rep = built
    assert rep["lane_mapping"].get("lane0_not_leftmost", 0) == 0
    assert rep["lane_mapping"].get("non_monotone", 0) == 0
    assert rep["lane_mapping"]["lane0_leftmost"] > 0


def test_connected(built):
    net, _ = built
    comps = netcheck.weak_components(net)
    assert len(comps) == 1


def test_every_link_reachable_from_an_entry_and_reaches_an_exit(built):
    net, _ = built
    g = netcheck.link_graph(net)
    ins = [z["link"] for z in net["zones"] if z["role"] == "in"]
    outs = {z["link"] for z in net["zones"] if z["role"] == "out"}
    reach = set().union(*(netcheck.reachable(g, s) for s in ins))
    for lk in net["links"]:
        assert lk["id"] in reach, f"{lk['id']} unreachable from entries"
        assert netcheck.reachable(g, lk["id"]) & outs, f"{lk['id']} cannot reach an exit"


def test_zones_at_boundary_links_with_stable_ids(built):
    net, _ = built
    nodes = {n["id"]: n for n in net["nodes"]}
    links = {lk["id"]: lk for lk in net["links"]}
    for z in net["zones"]:
        lk = links[z["link"]]
        end = lk["from"] if z["role"] == "in" else lk["to"]
        assert nodes[end]["kind"] == "boundary"
        assert z["id"].startswith(z["role"] + "-")
    # every boundary node has a zone on each of its links
    zoned = {z["link"] for z in net["zones"]}
    for lk in net["links"]:
        if nodes[lk["from"]]["kind"] == "boundary" or nodes[lk["to"]]["kind"] == "boundary":
            assert lk["id"] in zoned


def _tagged_layers(net):
    """OSM elevation of each link, from the OSM ways netconvert merged into it (origId)."""
    tags = way_tags(silkboard.BUILD_DIR / "silkboard.clipped.osm")
    sumo = silkboard.parse_net(silkboard.BUILD_DIR / "silkboard.net.xml")

    def tl(t):
        try:
            layer = max(0, int(t.get("layer", "0")))
        except ValueError:
            layer = 0
        return max(layer, 1) if t.get("bridge") in ("yes", "viaduct") else layer
    return {lk["id"]: max(tl(tags.get(w, {})) for w in sumo.edges[lk["id"]].orig_ways)
            for lk in net["links"]}


def test_flyovers_are_elevated(built):
    # every link built from a bridge/viaduct or layer ≥ 1 way is on layer ≥ 1
    net, _ = built
    tagged = _tagged_layers(net)
    assert any(v >= 1 for v in tagged.values())
    for lk in net["links"]:
        if tagged[lk["id"]] >= 1:
            assert lk["layer"] >= tagged[lk["id"]], lk["id"]


def test_elevated_links_are_tagged_or_ramps(built):
    # every link with layer ≥ 1 is tagged bridge/layer ≥ 1 in OSM, or is a ramp (its z changes)
    # one of whose ends touches a tagged layer ≥ 1 link; no untagged road is lifted otherwise
    net, _ = built
    tagged = _tagged_layers(net)
    at = {}
    for lk in net["links"]:
        for n in (lk["from"], lk["to"]):
            at.setdefault(n, []).append(lk["id"])
    for lk in net["links"]:
        if lk["layer"] >= 1 and tagged[lk["id"]] == 0:
            assert netcheck.is_ramp(lk), f"{lk['id']}: untagged, layer {lk['layer']}, flat"
            touches = [o for n in (lk["from"], lk["to"]) for o in at[n]
                       if o != lk["id"] and tagged[o] >= 1]
            assert touches, f"{lk['id']}: untagged layer-{lk['layer']} link touches no tagged link"
        if tagged[lk["id"]] == 0 and lk["layer"] == 0:
            assert lk["zFromM"] == 0 and lk["zToM"] == 0, lk["id"]


def test_levels_separate(built):
    # elevation continuous at every movement; layer changes only through ramps
    net, _ = built
    assert netcheck.level_errors(net, silkboard.LAYER_HEIGHT_M, tol=1e-6) == []


def test_signals_reference_signal_movements_at_their_node(built):
    net, _ = built
    movs = {m["id"]: m for m in net["movements"]}
    assert net["signals"], "netconvert default programmes expected"
    for s in net["signals"]:
        for ph in s["phases"]:
            for mid in ph["protected"] + ph["permissive"]:
                assert movs[mid]["node"] == s["node"]
                assert movs[mid]["control"] == "signal"
    for m in movs.values():
        if m["control"] == "signal":
            assert any(m["id"] in ph["protected"] + ph["permissive"]
                       for s in net["signals"] for ph in s["phases"]), m["id"]


def test_patches_all_have_reasons():
    data = json.loads(silkboard.PATCHES.read_text())
    assert all(p.get("reason") for p in data["patches"])


# ---------------------------------------------------- the checker itself catches violations

def _tiny():
    return {
        "version": 1, "id": "t", "name": "t",
        "nodes": [{"id": "a", "x": 0, "y": 0, "kind": "boundary"},
                  {"id": "b", "x": 100, "y": 0, "kind": "plain"},
                  {"id": "c", "x": 200, "y": 0, "kind": "boundary"}],
        "links": [{"id": "l1", "from": "a", "to": "b", "polyline": [[0, 0], [100, 0]],
                   "widthM": 7, "lanes": 2, "speedLimitMps": 14},
                  {"id": "l2", "from": "b", "to": "c", "polyline": [[100, 0], [200, 0]],
                   "widthM": 7, "lanes": 2, "speedLimitMps": 14}],
        "movements": [{"id": "m", "node": "b", "fromLink": "l1", "toLink": "l2",
                       "path": [[100, 0], [100.1, 0]], "widthM": 7,
                       "fromLateral": [0, 7], "toLateral": [0, 7], "control": "free"}],
        "signals": [{"node": "b", "phases": [{"greenS": 30, "protected": ["m"]}]}],
        "zones": [{"id": "in", "link": "l1", "role": "in"}, {"id": "out", "link": "l2", "role": "out"}],
    }


@pytest.mark.parametrize("mutate,needle", [
    (lambda n: n["nodes"].append(dict(n["nodes"][0])), "duplicate node"),
    (lambda n: n["links"][0].update({"from": "zz"}), "unknown from-node"),
    (lambda n: n["movements"][0].update({"node": "a"}), "fromLink does not end at node"),
    (lambda n: n["movements"][0].update({"toLink": "l1"}), "toLink does not start at node"),
    (lambda n: n["signals"][0]["phases"][0]["protected"].append("nope"), "unknown movement"),
    (lambda n: n["zones"][0].update({"link": "nope"}), "unknown link"),
    (lambda n: n["movements"][0].update({"fromLateral": [5, 1]}), "lo > hi"),
])
def test_checker_detects(mutate, needle):
    n = _tiny()
    assert netcheck.contract_errors(n) == []
    bad = copy.deepcopy(n)
    mutate(bad)
    errs = netcheck.contract_errors(bad)
    assert any(needle in e for e in errs), errs
