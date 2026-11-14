"""Silk Board (Bengaluru) network: OSM extract → clip → netconvert → Weave network JSON.

Conventions (see also data/osm/README.md and the report in the pipeline README section):

* Coordinates: netconvert is run with the equirectangular PROJ string from `geo.proj_string`
  around ORIGIN, with offset normalisation disabled, so net.xml coordinates are already our
  local metres (x east, y north).
* Link polyline = CARRIAGEWAY CENTRELINE in the direction of travel (docs/MODEL.md §0). It is
  built from the lane shapes, not from SUMO's edge `shape` (whose meaning depends on
  spreadType and lefthand): with lanes ordered left→right by their measured signed offset,
  left edge = leftmost lane centre + nL·w_left/2, right edge = rightmost lane centre −
  nL·w_right/2, centreline = their midpoint. widthM = Σ lane widths.
* Lateral bands: y is measured from the LEFT edge in the direction of travel. SUMO lane 0 is
  the outermost (kerb-side, slow) lane of an edge: in a right-hand network that is the
  rightmost lane, and in a `--lefthand` network netconvert mirrors the geometry so lane 0 is the
  LEFTMOST lane. Rather than relying on that, each lane's position is measured from its shape
  (signed offset from the centreline); the pipeline records the observed index→side mapping
  and the D4 test asserts it is consistent (lane 0 leftmost on every multi-lane edge).
  Lane k occupies y ∈ [Σ widths of lanes to its left, + w_k].
* Movements: one per (fromLink, toLink) pair, merging SUMO's lane-to-lane connections. Bands
  are the union of the connected lanes' bands. `path` = centreline of the internal path:
  the arc-length-resampled mean of the connections' internal lane shapes (following `via`
  chains through internal junctions); if that is degenerate (< MIN_PATH_M), a straight segment
  from the fromLink end to the toLink start (both at the band centres) is synthesised.
  widthM = Σ widths of the distinct first internal lanes (one per lane connection).
* foes: from the junction <request foes=...> matrix (request index i ↔ intLanes[i]), lifted to
  movement level (A foes B if any lane connection of A foes any of B). Cross-check only;
  `conflicts` is left absent (the engine computes it).
* Signals: see `_convert_tl`.
* Layers come from OSM tags, never from netconvert's interpolated elevation (which bleeds
  onto ordinary roads sharing a node with a ramp). See `assign_layers`.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import OUT_DIR, RAW_OSM, REPO_ROOT
from .geo import (bearing_deg, compass8, dedupe, left_normals, polyline_length, proj_string,
                  resample, signed_offset)
from .osm_clip import BBox, clip_osm, way_geometry, way_tags

PIPELINE_DIR = REPO_ROOT / "data-pipeline"
BUILD_DIR = PIPELINE_DIR / "build"
TYPEMAP = PIPELINE_DIR / "netconvert" / "silkboard.typ.xml"
PATCHES = PIPELINE_DIR / "patches" / "silkboard.json"
OSM_RAW = RAW_OSM / "silkboard.osm"

# Bounding box of the Overpass download (also recorded in data/osm/README.md).
BBOX = BBox(south=12.9119, west=77.6173, north=12.9229, east=77.6285)
ORIGIN = (12.9174, 77.6229)  # (lat, lon): centre of BBOX
LAYER_HEIGHT_M = 6.0
MIN_PATH_M = 0.5
RESAMPLE_N = 24

NETCONVERT_ARGS = [
    "--lefthand", "true",                 # India drives on the left
    "--junctions.join", "true",           # merge dual-carriageway node clusters
    "--remove-edges.isolated", "true",
    "--osm.layer-elevation", str(LAYER_HEIGHT_M),  # keep layers/bridges; interpolated ramp z
    "--tls.guess-signals", "true",
    "--tls.join", "true",
    "--tls.default-type", "static",
    "--tls.yellow.time", "3",
    "--tls.allred.time", "2",
    "--no-turnarounds", "true",
    "--geometry.remove", "true",          # merge edges at pure geometry nodes
    "--output.original-names", "true",    # lane param origId = every OSM way merged into the edge
    "--offset.disable-normalization", "true",
]
# Internal lanes are kept (netconvert default, i.e. no --no-internal-links).

Point = tuple[float, float]


# --------------------------------------------------------------------------------------------
# net.xml parsing


def _shape(s: str) -> tuple[list[Point], list[float]]:
    pts, zs = [], []
    for tok in s.split():
        parts = [float(v) for v in tok.split(",")]
        pts.append((parts[0], parts[1]))
        zs.append(parts[2] if len(parts) > 2 else 0.0)
    return pts, zs


@dataclass
class Lane:
    id: str
    index: int
    width: float
    speed: float
    shape: list[Point]
    z: list[float]


@dataclass
class Edge:
    id: str
    frm: str
    to: str
    type: str
    lanes: list[Lane]
    # derived
    centre: list[Point] = field(default_factory=list)
    width: float = 0.0
    band: dict[int, tuple[float, float]] = field(default_factory=dict)  # lane index → (yLo, yHi)
    left_to_right: list[int] = field(default_factory=list)
    z_from: float = 0.0
    z_to: float = 0.0
    orig_ways: list[str] = field(default_factory=list)


@dataclass
class Conn:
    frm: str
    to: str
    from_lane: int
    to_lane: int
    via: str | None
    dir: str
    state: str
    tl: str | None
    link_index: int | None


@dataclass
class Net:
    junctions: dict[str, ET.Element]
    edges: dict[str, Edge]
    internal_lanes: dict[str, Lane]
    conns: list[Conn]          # connections between normal edges
    internal_conns: dict[str, Conn]  # internal lane id → onward connection (via chains)
    tls: list[ET.Element]
    location: dict[str, str]


def parse_net(path: Path) -> Net:
    root = ET.parse(path).getroot()
    junctions = {j.get("id"): j for j in root.findall("junction") if j.get("type") != "internal"}
    edges: dict[str, Edge] = {}
    internal_lanes: dict[str, Lane] = {}
    for e in root.findall("edge"):
        lanes = []
        for ln in e.findall("lane"):
            pts, zs = _shape(ln.get("shape"))
            lanes.append(Lane(ln.get("id"), int(ln.get("index")), float(ln.get("width", 3.2)),
                              float(ln.get("speed")), pts, zs))
        if e.get("function") == "internal":
            for ln in lanes:
                internal_lanes[ln.id] = ln
        elif e.get("function") in (None, "normal"):
            ed = Edge(e.get("id"), e.get("from"), e.get("to"), e.get("type", ""), lanes)
            ln0 = e.find("lane")
            orig = [prm.get("value") for prm in ln0.findall("param") if prm.get("key") == "origId"]
            ed.orig_ways = sorted({_osm_way_of(w) for w in orig[0].split()}) if orig else \
                [_osm_way_of(ed.id)]
            edges[ed.id] = ed
    conns, internal_conns = [], {}
    for c in root.findall("connection"):
        cc = Conn(c.get("from"), c.get("to"), int(c.get("fromLane")), int(c.get("toLane")),
                  c.get("via"), c.get("dir"), c.get("state"), c.get("tl"),
                  int(c.get("linkIndex")) if c.get("linkIndex") is not None else None)
        if cc.frm.startswith(":"):
            internal_conns[f"{cc.frm}_{cc.from_lane}"] = cc
        else:
            conns.append(cc)
    loc = root.find("location")
    return Net(junctions, edges, internal_lanes, conns, internal_conns,
               root.findall("tlLogic"), dict(loc.attrib) if loc is not None else {})


# --------------------------------------------------------------------------------------------
# geometry derivation


def _pointwise(shapes: list[list[Point]]) -> list[list[Point]]:
    """Bring lane shapes to a common vertex count (they usually already share it)."""
    shapes = [dedupe(s) for s in shapes]
    if len({len(s) for s in shapes}) == 1 and len(shapes[0]) >= 2:
        return shapes
    n = max(RESAMPLE_N, 2 * max(len(s) for s in shapes))
    return [resample(s, n) for s in shapes]


def derive_edge_geometry(e: Edge) -> None:
    shapes = _pointwise([ln.shape for ln in e.lanes])
    ref = shapes[0]
    offs = []
    for ln, sh in zip(e.lanes, shapes):
        mid = sh[len(sh) // 2] if len(sh) > 2 else ((sh[0][0] + sh[-1][0]) / 2, (sh[0][1] + sh[-1][1]) / 2)
        offs.append(signed_offset(mid, ref) if ln is not e.lanes[0] else 0.0)
    order = sorted(range(len(e.lanes)), key=lambda i: -offs[i])  # most-left first
    e.left_to_right = [e.lanes[i].index for i in order]
    li, ri = order[0], order[-1]
    L, R = shapes[li], shapes[ri]
    wl, wr = e.lanes[li].width, e.lanes[ri].width
    mean = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(L, R)]
    nL = left_normals(mean if len(e.lanes) > 1 else L)
    e.centre = dedupe([
        ((a[0] + nl[0] * wl / 2 + b[0] - nl[0] * wr / 2) / 2,
         (a[1] + nl[1] * wl / 2 + b[1] - nl[1] * wr / 2) / 2)
        for a, b, nl in zip(L, R, nL)])
    if len(e.centre) < 2:
        e.centre = [L[0], L[-1]]
    e.width = sum(ln.width for ln in e.lanes)
    y = 0.0
    for i in order:
        ln = e.lanes[i]
        e.band[ln.index] = (y, y + ln.width)
        y += ln.width
    e.z_from = sum(ln.z[0] for ln in e.lanes) / len(e.lanes)
    e.z_to = sum(ln.z[-1] for ln in e.lanes) / len(e.lanes)


def _via_chain(net: Net, via: str | None) -> list[Lane]:
    out = []
    seen = set()
    while via and via in net.internal_lanes and via not in seen:
        seen.add(via)
        out.append(net.internal_lanes[via])
        nxt = net.internal_conns.get(via)
        via = nxt.via if nxt is not None else None
    return out


def _point_at_lateral(line: list[Point], width: float, y: float, at_end: bool) -> Point:
    """World point at the start/end of a centreline for lateral y from the left edge."""
    nl = left_normals(line)[-1 if at_end else 0]
    p = line[-1 if at_end else 0]
    off = width / 2 - y
    return (p[0] + nl[0] * off, p[1] + nl[1] * off)


# --------------------------------------------------------------------------------------------
# conversion


def _osm_way_of(edge_id: str) -> str:
    return re.sub(r"#\d+$", "", edge_id.lstrip("-"))


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _rnd(p: Point) -> list[float]:
    return [round(p[0], 2), round(p[1], 2)]


def _convert_tl(tl: ET.Element, conn_by_tl_index: dict[tuple[str, int], list[str]],
                movement_node: dict[str, str]) -> tuple[list[dict], list[str]]:
    """netconvert tlLogic → one Weave signal plan per controlled node.

    netconvert phase states are strings over the tl's link indices: 'G' priority green,
    'g' green-but-yield, 'y' amber, 'r'/'s' red. Conversion:
    * A *green phase* is a phase with at least one G/g and no 'y'. Each becomes one Weave
      phase with greenS = its duration. A movement (all of whose lane connections share the
      phase) is `protected` if every lane connection is 'G', `permissive` if any is green but
      not all are 'G' (mixed G/g → permissive).
    * Phases containing 'y' are the inter-green after the preceding green phase: amberS = the
      longest such phase; all-red phases (only 'r'/'s') give allRedS = the longest one
      (0 if none). Weave applies one amberS/allRedS after every phase.
      Simplification: per-phase differences in amber/all-red are lost (netconvert used 3 s and
      2 s everywhere here because of --tls.yellow.time 3 --tls.allred.time 2). For each node,
      consecutive phases with identical (protected, permissive) sets are merged into one phase
      whose greenS also absorbs the intergreen between them, so the node's cycle length is
      unchanged and no spurious amber is inserted (no merge across the cycle wrap-around).
      Within a netconvert phase, a movement whose lane connections are partly green is
      treated as green.
    * offsetS = tlLogic offset.
    * A joined tl that controls several nodes yields one plan per node with identical phase
      timing (phases where that node has nothing green keep their greenS with empty lists),
      so the nodes stay coordinated.
    """
    notes = []
    phases = [(float(p.get("duration")), p.get("state")) for p in tl.findall("phase")]
    amber = max([d for d, s in phases if "y" in s] or [0.0])
    allred = max([d for d, s in phases if s and set(s) <= {"r", "s"}] or [0.0])
    green = [(d, s) for d, s in phases if any(ch in "Gg" for ch in s) and "y" not in s]
    # movement → its tl link indices
    mov_idx: dict[str, list[int]] = defaultdict(list)
    for (tid, idx), movs in conn_by_tl_index.items():
        if tid == tl.get("id"):
            for m in movs:
                mov_idx[m].append(idx)
    nodes = sorted({movement_node[m] for m in mov_idx})
    plans = []
    for node in nodes:
        out_phases = []
        for d, s in green:
            prot, perm = [], []
            for m in sorted(mov_idx):
                if movement_node[m] != node:
                    continue
                chars = [s[i] for i in mov_idx[m] if i < len(s)]
                if chars and all(c == "G" for c in chars):
                    prot.append(m)
                elif any(c in "Gg" for c in chars):
                    perm.append(m)
            if out_phases and out_phases[-1]["protected"] == prot \
                    and out_phases[-1]["permissive"] == perm:
                # same movements green in consecutive phases: merge, absorbing the
                # intergreen between them so the cycle length is unchanged
                out_phases[-1]["greenS"] += amber + allred + d
            else:
                out_phases.append({"greenS": d, "protected": prot, "permissive": perm})
        if not out_phases:
            notes.append(f"tl {tl.get('id')}: no green phase; skipped")
            continue
        plans.append({"node": node, "offsetS": max(0.0, float(tl.get("offset", 0))),
                      "amberS": amber, "allRedS": allred, "phases": out_phases})
    return plans, notes


def _node_kind(jtype: str, n_in: int, n_out: int) -> str:
    if jtype == "traffic_light":
        return "signal"
    if jtype == "dead_end" or n_in == 0 or n_out == 0:
        return "boundary"
    if n_in == 1 and n_out == 1:
        return "plain"
    if n_in == 1:
        return "diverge"
    if n_out == 1:
        return "merge"
    return "priority"


def _netconvert(osm: Path, out: Path, args: list[str]) -> str:
    lat0, lon0 = ORIGIN
    cmd = [shutil.which("netconvert") or "netconvert", "--osm-files", str(osm),
           "--type-files", str(TYPEMAP), *args,
           "--proj", proj_string(lat0, lon0), "-o", str(out)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"netconvert failed:\n{res.stderr}")
    return res.stderr


def run_netconvert(osm: Path, out: Path, tags: dict[str, dict[str, str]]) -> list[str]:
    """Two passes. `--geometry.remove` merges consecutive edges regardless of OSM layer/bridge
    tags, which would fold a short bridge into a long ground road (or a ground approach into a
    deck). Pass 1 runs without it to get the unmerged edges; every edge of an elevated way
    (tag_layer ≥ 1) and every edge touching one of its end nodes is then protected with
    `--geometry.remove.keep-edges.input-file`, so merges only happen inside runs of
    same-elevation ways away from any elevation boundary. Returns the protected edge ids."""
    args1 = []
    k = 0
    while k < len(NETCONVERT_ARGS):
        if NETCONVERT_ARGS[k] == "--geometry.remove":
            k += 2
            continue
        args1.append(NETCONVERT_ARGS[k])
        k += 1
    pass1 = out.parent / "silkboard.pass1.net.xml"
    _netconvert(osm, pass1, args1)
    net1 = parse_net(pass1)
    elevated = {eid for eid, e in net1.edges.items()
                if max(tag_layer(tags.get(w, {})) for w in e.orig_ways) >= 1}
    ends = {n for eid in elevated for n in (net1.edges[eid].frm, net1.edges[eid].to)}
    keep = sorted(elevated | {eid for eid, e in net1.edges.items() if e.frm in ends or e.to in ends})
    keep_file = out.parent / "silkboard.keep-edges.txt"
    keep_file.write_text("".join(f"edge:{eid}\n" for eid in keep))
    log = _netconvert(osm, out, [*NETCONVERT_ARGS,
                                 "--geometry.remove.keep-edges.input-file", str(keep_file)])
    (out.parent / "netconvert.log").write_text(log)
    return keep


def tag_layer(t: dict[str, str]) -> int:
    """OSM elevation of one way: its `layer` tag (≥ 0); bridge=yes/viaduct implies ≥ 1."""
    try:
        layer = max(0, int(t.get("layer", "0")))
    except ValueError:
        layer = 0
    if t.get("bridge") in ("yes", "viaduct"):
        layer = max(layer, 1)
    return layer


def _twin(eid: str) -> str:
    return eid[1:] if eid.startswith("-") else "-" + eid


def _segments_cross(p1, p2, q1, q2) -> bool:
    """Proper 2-D intersection of segments p1p2 and q1q2 (touching endpoints excluded)."""
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = orient(q1, q2, p1), orient(q1, q2, p2)
    d3, d4 = orient(p1, p2, q1), orient(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def structure_ways(tags: dict[str, dict[str, str]], ways: dict[str, list[str]],
                   nodes: dict[str, tuple[float, float]]) -> tuple[set[str], dict]:
    """Elevated OSM ways that form grade-separated structures.

    Elevated ways (tag_layer ≥ 1) are grouped into components through shared nodes. A
    component is a STRUCTURE (flyover, deck, elevated ramp) if any of its ways crosses, in
    plan, a way it shares no node with: it passes over another road. Otherwise it is an
    at-grade bridge (here: short bridges over drains, with an ordinary road continuing at each
    end), which crosses no road.
    """
    from .geo import to_local
    lat0, lon0 = ORIGIN
    xy = {n: to_local(la, lo, lat0, lon0) for n, (la, lo) in nodes.items()}
    elev = sorted(w for w in ways if tag_layer(tags.get(w, {})) >= 1)
    parent = {w: w for w in elev}

    def find(w):
        while parent[w] != w:
            parent[w] = parent[parent[w]]
            w = parent[w]
        return w
    by_node = defaultdict(list)
    for w in elev:
        for n in ways[w]:
            by_node[n].append(w)
    for ws in by_node.values():
        for w in ws[1:]:
            parent[find(w)] = find(ws[0])
    comps = defaultdict(list)
    for w in elev:
        comps[find(w)].append(w)
    segs = {w: [(xy[a], xy[b]) for a, b in zip(ways[w], ways[w][1:]) if a in xy and b in xy]
            for w in ways}
    structures: set[str] = set()
    info = {}
    for root_w, ws in comps.items():
        crossed = set()
        for w in ws:
            mine = set(ways[w])
            for o, osegs in segs.items():
                if o == w or mine & set(ways[o]):
                    continue
                if any(_segments_cross(p1, p2, q1, q2) for p1, p2 in segs[w] for q1, q2 in osegs):
                    crossed.add(o)
        is_struct = bool(crossed)
        if is_struct:
            structures.update(ws)
        info[",".join(sorted(ws))] = {"structure": is_struct, "crosses": sorted(crossed)[:8]}
    return structures, info


def assign_layers(edges: dict[str, Edge], tags: dict[str, dict[str, str]],
                  structures: set[str]) -> dict[str, dict]:
    """Tag-first layers (z from netconvert is never used).

    * tagged(L) = max tag_layer over the OSM ways merged into edge L (lane param origId);
      edges of elevated ways are protected from merging, so this is one way's tags.
    * Node height h(N) = H × max layer of the STRUCTURE edges at N (0 if none).
    * zFrom/zTo = h(from)/h(to); layer = max(tagged, round(max(zFrom, zTo)/H)).
    So deck edges sit at their layer; an untagged edge touching a structure is a ramp with the
    upper layer and a 0 → H·layer profile; an at-grade bridge keeps its tagged layer with
    z = 0 at both ends and does not lift its approaches; every other edge is layer 0, z = 0.
    """
    tagged = {eid: max(tag_layer(tags.get(w, {})) for w in e.orig_ways) for eid, e in edges.items()}
    is_struct = {eid: any(w in structures for w in e.orig_ways) for eid, e in edges.items()}
    h: dict[str, int] = defaultdict(int)
    for eid, e in edges.items():
        if is_struct[eid]:
            for n in (e.frm, e.to):
                h[n] = max(h[n], tagged[eid])
    out = {}
    for eid, e in edges.items():
        lf, lt = h[e.frm], h[e.to]
        layer = max(tagged[eid], lf, lt)
        if is_struct[eid]:
            reason = (f"structure (tagged layer {tagged[eid]}, crosses roads)" if lf == lt == tagged[eid]
                      else f"structure (tagged layer {tagged[eid]}); ends at {lf * LAYER_HEIGHT_M:g}/"
                           f"{lt * LAYER_HEIGHT_M:g} m where it meets layer-{max(lf, lt)} structure")
        elif tagged[eid] >= 1:
            reason = f"at-grade bridge (tagged layer {tagged[eid]}, crosses no road): z = 0"
        elif layer >= 1:
            reason = f"ramp: untagged way joining a layer-{layer} structure to the ground"
        else:
            reason = "ground"
        out[eid] = {"tagged": tagged[eid], "structure": is_struct[eid], "layer": layer,
                    "end_from": lf, "end_to": lt, "ways": e.orig_ways, "reason": reason}
    return out


def convert(net: Net, tags: dict[str, dict[str, str]], structures: set[str] | None = None) -> tuple[dict, dict]:
    """Build the Weave network dict from a parsed net. Returns (network, report)."""
    report: dict = {"notes": []}
    structures = structures or set()
    for e in net.edges.values():
        derive_edge_geometry(e)

    # lane index → side mapping check
    mapping = defaultdict(int)
    for e in net.edges.values():
        if len(e.lanes) > 1:
            mapping["lane0_leftmost" if e.left_to_right[0] == 0 else "lane0_not_leftmost"] += 1
            if e.left_to_right != sorted(e.left_to_right):
                mapping["non_monotone"] += 1
    report["lane_mapping"] = dict(mapping)

    links = []
    layers = assign_layers(net.edges, tags, structures)
    report["layers"] = layers
    # for the change log: the previous rule, max(tag of the edge's first way, round(max z/H))
    report["layer_changes"] = {}
    for eid, e in net.edges.items():
        t0 = tags.get(_osm_way_of(eid), {})
        try:
            old_tag = max(0, int(t0.get("layer", "0")))
        except ValueError:
            old_tag = 0
        old = max(old_tag, int(round(max(e.z_from, e.z_to) / LAYER_HEIGHT_M)))
        if old != layers[eid]["layer"]:
            report["layer_changes"][eid] = {"old": old, "new": layers[eid]["layer"],
                                            "reason": layers[eid]["reason"], "ways": e.orig_ways}
    node_layer: dict[str, int] = defaultdict(int)
    for eid in sorted(net.edges):
        e = net.edges[eid]
        L = layers[eid]
        node_layer[e.frm] = max(node_layer[e.frm], L["end_from"])
        node_layer[e.to] = max(node_layer[e.to], L["end_to"])
        layer = L["layer"]
        e.z_from, e.z_to = L["end_from"] * LAYER_HEIGHT_M, L["end_to"] * LAYER_HEIGHT_M
        links.append({
            "id": eid, "from": e.frm, "to": e.to,
            "polyline": [_rnd(p) for p in e.centre],
            "widthM": round(e.width, 3), "lanes": len(e.lanes),
            "speedLimitMps": round(max(ln.speed for ln in e.lanes), 3),
            "layer": layer, "zFromM": round(e.z_from, 2), "zToM": round(e.z_to, 2),
        })

    n_in, n_out = defaultdict(int), defaultdict(int)
    for e in net.edges.values():
        n_out[e.frm] += 1
        n_in[e.to] += 1
    nodes = []
    for jid in sorted(net.junctions):
        j = net.junctions[jid]
        if n_in[jid] + n_out[jid] == 0:
            continue
        nodes.append({"id": jid, "x": round(float(j.get("x")), 2), "y": round(float(j.get("y")), 2),
                      "kind": _node_kind(j.get("type"), n_in[jid], n_out[jid]),
                      "layer": node_layer[jid]})
    node_kind = {n["id"]: n["kind"] for n in nodes}

    # group lane connections into movements
    groups: dict[tuple[str, str], list[Conn]] = defaultdict(list)
    for c in net.conns:
        if c.frm in net.edges and c.to in net.edges:
            groups[(c.frm, c.to)].append(c)

    # junction request index → movement (for foes)
    int_lane_to_mov: dict[str, str] = {}
    movements = []
    movement_node: dict[str, str] = {}
    conn_by_tl_index: dict[tuple[str, int], list[str]] = defaultdict(list)
    synthesized = 0
    for (fl, tl_), cs in sorted(groups.items()):
        ef, et = net.edges[fl], net.edges[tl_]
        node = ef.to
        mid = f"{fl}>{tl_}"
        movement_node[mid] = node
        fb = [ef.band[c.from_lane] for c in cs]
        tb = [et.band[c.to_lane] for c in cs]
        from_lat = (min(b[0] for b in fb), max(b[1] for b in fb))
        to_lat = (min(b[0] for b in tb), max(b[1] for b in tb))
        chains = [_via_chain(net, c.via) for c in cs]
        paths = []
        for ch in chains:
            pts: list[Point] = []
            for ln in ch:
                pts.extend(ln.shape)
            pts = dedupe(pts)
            if len(pts) >= 2 and polyline_length(pts) >= MIN_PATH_M:
                paths.append(pts)
        if paths and len(paths) == len(chains):
            if len(paths) == 1:
                path = paths[0]
            else:
                rs = [resample(p, RESAMPLE_N) for p in paths]
                path = [(sum(r[k][0] for r in rs) / len(rs), sum(r[k][1] for r in rs) / len(rs))
                        for k in range(RESAMPLE_N)]
        else:
            a = _point_at_lateral(ef.centre, ef.width, (from_lat[0] + from_lat[1]) / 2, True)
            b = _point_at_lateral(et.centre, et.width, (to_lat[0] + to_lat[1]) / 2, False)
            path = [a, b]
            synthesized += 1
            if math.dist(a, b) < 1e-3:
                # coincident ends: give the path a 1 cm extent along the toLink direction
                d = et.centre[1][0] - et.centre[0][0], et.centre[1][1] - et.centre[0][1]
                L = math.hypot(*d) or 1.0
                path = [a, (a[0] + 0.01 * d[0] / L, a[1] + 0.01 * d[1] / L)]
        first_lanes = {ch[0].id: ch[0].width for ch in chains if ch}
        width = sum(first_lanes.values()) if first_lanes else (from_lat[1] - from_lat[0])
        tls = {c.tl for c in cs if c.tl}
        states = {c.state for c in cs}
        if tls:
            control = "signal"
            for c in cs:
                conn_by_tl_index[(c.tl, c.link_index)].append(mid)
        elif node_kind.get(node) in ("plain", "boundary"):
            control = "free"
        elif states <= {"M", "O"}:
            control = "major"
        else:
            control = "minor"
        for ch in chains:
            if ch:
                int_lane_to_mov[ch[0].id] = mid
        movements.append({
            "id": mid, "node": node, "fromLink": fl, "toLink": tl_,
            "path": [_rnd(p) for p in path],
            "widthM": round(width, 3),
            "fromLateral": [round(from_lat[0], 3), round(from_lat[1], 3)],
            "toLateral": [round(to_lat[0], 3), round(to_lat[1], 3)],
            "control": control,
        })
    report["synthesized_paths"] = synthesized
    # dedupe conn_by_tl_index lists
    for k in list(conn_by_tl_index):
        conn_by_tl_index[k] = sorted(set(conn_by_tl_index[k]))

    # foes from junction request matrices
    foes: dict[str, set[str]] = defaultdict(set)
    for jid, j in net.junctions.items():
        ints = j.get("intLanes", "").split()
        for req in j.findall("request"):
            i = int(req.get("index"))
            f = req.get("foes", "")
            n = len(f)
            if i >= len(ints) or ints[i] not in int_lane_to_mov:
                continue
            mi = int_lane_to_mov[ints[i]]
            for k in range(n):
                if f[n - 1 - k] == "1" and k < len(ints) and ints[k] in int_lane_to_mov:
                    mk = int_lane_to_mov[ints[k]]
                    if mk != mi:
                        foes[mi].add(mk)
    for m in movements:
        if foes.get(m["id"]):
            m["foes"] = sorted(foes[m["id"]])
        if m["control"] == "free" and foes.get(m["id"]):
            m["control"] = "minor"

    signals = []
    for tl in net.tls:
        plans, notes = _convert_tl(tl, conn_by_tl_index, movement_node)
        signals.extend(plans)
        report["notes"].extend(notes)
    signals.sort(key=lambda s: s["node"])

    # zones: one per boundary link (a link starting or ending at a boundary node)
    boundary = {n["id"] for n in nodes if n["kind"] == "boundary"}
    pos = {n["id"]: (n["x"], n["y"]) for n in nodes}
    zones = []
    used: set[str] = set()
    for lk in links:
        role = "in" if lk["from"] in boundary else "out" if lk["to"] in boundary else None
        if role is None:
            continue
        name = tags.get(_osm_way_of(lk["id"]), {}).get("name") or \
            tags.get(_osm_way_of(lk["id"]), {}).get("highway", "road")
        bnode = pos[lk["from"] if role == "in" else lk["to"]]
        side = compass8(bearing_deg((0.0, 0.0), bnode))  # where the boundary point lies
        base = f"{role}-{side}-{_slug(name)}"
        zid, k = base, 2
        while zid in used:
            zid, k = f"{base}-{k}", k + 1
        used.add(zid)
        zones.append({"id": zid, "link": lk["id"], "role": role,
                      "label": f"{name} ({side.upper()}, {role})"})
    zones.sort(key=lambda z: z["id"])

    lat0, lon0 = ORIGIN
    network = {
        "version": 1, "id": "silkboard",
        "name": "Central Silk Board junction, Bengaluru (OSM)",
        "origin": {"lat": lat0, "lon": lon0},
        "nodes": nodes, "links": links, "movements": movements,
        "signals": signals, "zones": zones,
    }
    return network, report


# --------------------------------------------------------------------------------------------
# patches


PRE_OPS = {"join_junctions"}


def apply_patches(network: dict, patches: list[dict]) -> list[str]:
    """Hand fixes. Each patch: {op, reason, ...}. Pre-netconvert op (applied in `build`):
    - {"op": "join_junctions", "nodes": [osm node ids], "keep"?: id}: fuse the OSM nodes into
      one (at `keep`'s position, else their centroid) in the clipped OSM before netconvert.
    Post-conversion ops:
    - {"op": "set_link", "id", "fields": {...}}
    - {"op": "set_node", "id", "fields": {...}}
    - {"op": "remove_movement", "id"}
    - {"op": "remove_link", "id"} (also removes its movements, zones, and signal references)
    """
    log = []
    for p in patches:
        if not p.get("reason"):
            raise ValueError(f"patch without reason: {p}")
        op = p["op"]
        if op in PRE_OPS:
            log.append(f"{op} {' '.join(p['nodes'])}: {p['reason']}")
            continue
        if op in ("set_link", "set_node"):
            coll = network["links" if op == "set_link" else "nodes"]
            hit = [x for x in coll if x["id"] == p["id"]]
            if not hit:
                raise KeyError(f"patch target not found: {p}")
            hit[0].update(p["fields"])
        elif op == "remove_movement":
            _remove_movements(network, {p["id"]})
        elif op == "remove_link":
            lid = p["id"]
            network["links"] = [lk for lk in network["links"] if lk["id"] != lid]
            gone = {m["id"] for m in network["movements"] if lid in (m["fromLink"], m["toLink"])}
            _remove_movements(network, gone)
            network["zones"] = [z for z in network["zones"] if z["link"] != lid]
        else:
            raise ValueError(f"unknown patch op {op}")
        log.append(f"{op} {p.get('id')}: {p['reason']}")
    return log


def prune(network: dict) -> list[str]:
    """After patches: repeatedly remove links that no entry zone can reach or that cannot reach
    an exit zone (with their movements, zones and signal references), then nodes left without
    links and signal plans at removed nodes. Returns a log line per removal."""
    log = []
    while True:
        succ: dict[str, set[str]] = defaultdict(set)
        pred: dict[str, set[str]] = defaultdict(set)
        for m in network["movements"]:
            succ[m["fromLink"]].add(m["toLink"])
            pred[m["toLink"]].add(m["fromLink"])

        def closure(starts, g):
            seen, stack = set(starts), list(starts)
            while stack:
                u = stack.pop()
                for v in g[u]:
                    if v not in seen:
                        seen.add(v)
                        stack.append(v)
            return seen
        fwd = closure([z["link"] for z in network["zones"] if z["role"] == "in"], succ)
        bwd = closure([z["link"] for z in network["zones"] if z["role"] == "out"], pred)
        dead = [lk["id"] for lk in network["links"] if lk["id"] not in fwd or lk["id"] not in bwd]
        if not dead:
            break
        for lid in dead:
            why = "unreachable from every entry zone" if lid not in fwd else "cannot reach any exit zone"
            log.append(f"pruned link {lid}: {why} after patches")
        dead_set = set(dead)
        network["links"] = [lk for lk in network["links"] if lk["id"] not in dead_set]
        _remove_movements(network, {m["id"] for m in network["movements"]
                                    if m["fromLink"] in dead_set or m["toLink"] in dead_set})
        network["zones"] = [z for z in network["zones"] if z["link"] not in dead_set]
    used = {n for lk in network["links"] for n in (lk["from"], lk["to"])}
    for n in network["nodes"]:
        if n["id"] not in used:
            log.append(f"pruned node {n['id']}: no links left")
    network["nodes"] = [n for n in network["nodes"] if n["id"] in used]
    network["signals"] = [sg for sg in network["signals"] if sg["node"] in used]
    return log


def _remove_movements(network: dict, ids: set[str]) -> None:
    network["movements"] = [m for m in network["movements"] if m["id"] not in ids]
    for m in network["movements"]:
        if "foes" in m:
            m["foes"] = [f for f in m["foes"] if f not in ids]
    for s in network["signals"]:
        for ph in s["phases"]:
            ph["protected"] = [x for x in ph["protected"] if x not in ids]
            ph["permissive"] = [x for x in ph["permissive"] if x not in ids]


# --------------------------------------------------------------------------------------------


def build(out_path: Path | None = None) -> tuple[dict, dict]:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    clipped = BUILD_DIR / "silkboard.clipped.osm"
    patches = json.loads(PATCHES.read_text())["patches"] if PATCHES.exists() else []
    joins = [p for p in patches if p["op"] == "join_junctions"]
    clip_stats = clip_osm(OSM_RAW, clipped, BBOX, merge=joins)
    net_xml = BUILD_DIR / "silkboard.net.xml"
    tags = way_tags(clipped)
    keep = run_netconvert(clipped, net_xml, tags)
    net = parse_net(net_xml)
    structures, sinfo = structure_ways(tags, *way_geometry(clipped))
    network, report = convert(net, tags, structures)
    report["protected_edges"] = len(keep)
    report["elevated_components"] = sinfo
    report["clip"] = clip_stats
    report["patches"] = apply_patches(network, patches)
    report["pruned"] = prune(network)
    out_path = out_path or OUT_DIR / "silkboard.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(network, separators=(",", ":")) + "\n")
    return network, report
