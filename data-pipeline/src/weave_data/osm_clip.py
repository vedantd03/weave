"""Clip an OSM extract to a lat/lon bounding box before netconvert.

Overpass returns every way that touches the box *in full*, and netconvert's
`--keep-edges.in-geo-boundary` keeps edges that are only partly inside, so without clipping
the network would sprawl several kilometres along the arterials. Here each way is cut at the
box: runs of the way inside the box are kept, and a new node is interpolated where the way
crosses the box edge. Nodes inside the box keep their OSM ids, so junction topology is
unchanged. Every kept way gets the tag `weave:way=<original OSM way id>` for traceability.

Determinism: new ids are assigned by a counter in file order, so the same input gives the
same output.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

NEW_NODE_ID_BASE = 9_000_000_000_000
SPLIT_WAY_FACTOR = 100  # split run k of way W gets id W*100 + k + 1
# A run cut by the box edge that is shorter than this is dropped: a stub that barely enters
# the box has no useful approach length and becomes a sub-metre link after netconvert.
MIN_CUT_RUN_M = 15.0


@dataclass(frozen=True)
class BBox:
    south: float
    west: float
    north: float
    east: float

    def inside(self, lat: float, lon: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lon <= self.east

    @property
    def centre(self) -> tuple[float, float]:
        return ((self.south + self.north) / 2, (self.west + self.east) / 2)


def _clip_segment(bb: BBox, p: tuple[float, float], q: tuple[float, float]):
    """Liang–Barsky in (lat, lon). Returns (t0, t1) of the part inside, or None."""
    t0, t1 = 0.0, 1.0
    dlat, dlon = q[0] - p[0], q[1] - p[1]
    for pk, qk in ((-dlat, p[0] - bb.south), (dlat, bb.north - p[0]),
                   (-dlon, p[1] - bb.west), (dlon, bb.east - p[1])):
        if pk == 0:
            if qk < 0:
                return None
            continue
        r = qk / pk
        if pk < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return (t0, t1) if t0 <= t1 else None


def _run_length(run, nodes, new_nodes) -> float:
    pos = dict(nodes)
    pos.update({nid: (lat, lon) for nid, lat, lon in new_nodes})
    k = math.pi / 180.0
    total = 0.0
    for a, b in zip(run, run[1:]):
        (la, oa), (lb, ob) = pos[a], pos[b]
        dx = (ob - oa) * k * math.cos((la + lb) / 2 * k) * 6371008.8
        dy = (lb - la) * k * 6371008.8
        total += math.hypot(dx, dy)
    return total


def clip_osm(src: Path, dst: Path, bb: BBox, merge: list[dict] | None = None) -> dict:
    """Clip to `bb`. `merge` lists node groups to fuse before clipping, each
    {"nodes": [OSM node ids], "keep": optional id}: the group becomes its first node, placed at
    the `keep` node's position if given, else at the group centroid. Used for forced junction
    joins that netconvert refused to do itself."""
    tree = ET.parse(src)
    root = tree.getroot()
    nodes: dict[str, tuple[float, float]] = {}
    for n in root.findall("node"):
        nodes[n.get("id")] = (float(n.get("lat")), float(n.get("lon")))
    rep: dict[str, str] = {}
    for spec in merge or []:
        group = spec["nodes"]
        missing = [g for g in group if g not in nodes]
        if missing:
            raise KeyError(f"merge group {group}: unknown nodes {missing}")
        if spec.get("keep"):
            lat, lon = nodes[spec["keep"]]
        else:
            lat = sum(nodes[g][0] for g in group) / len(group)
            lon = sum(nodes[g][1] for g in group) / len(group)
        nodes[group[0]] = (lat, lon)
        for g in group[1:]:
            rep[g] = group[0]
    for n in root.findall("node"):
        if n.get("id") in nodes and n.get("id") not in rep:
            n.set("lat", f"{nodes[n.get('id')][0]:.7f}")
            n.set("lon", f"{nodes[n.get('id')][1]:.7f}")

    new_nodes: list[tuple[str, float, float]] = []
    counter = [0]

    def make_node(lat: float, lon: float) -> str:
        counter[0] += 1
        nid = str(NEW_NODE_ID_BASE + counter[0])
        new_nodes.append((nid, lat, lon))
        return nid

    out_root = ET.Element("osm", {"version": "0.6", "generator": "weave_data.osm_clip"})
    for child in root:
        if child.tag in ("note", "meta", "bounds"):
            out_root.append(child)
    ET.SubElement(out_root, "bounds", {
        "minlat": str(bb.south), "minlon": str(bb.west),
        "maxlat": str(bb.north), "maxlon": str(bb.east)})

    used_nodes: set[str] = set()
    kept_ways: list[ET.Element] = []
    stats = {"ways_in": 0, "ways_kept_whole": 0, "ways_split": 0, "ways_dropped": 0, "runs": 0}
    for w in root.findall("way"):
        stats["ways_in"] += 1
        refs = []
        for nd in w.findall("nd"):
            r = rep.get(nd.get("ref"), nd.get("ref"))
            if r in nodes and (not refs or refs[-1] != r):
                refs.append(r)
        tags = [t for t in w.findall("tag")]
        runs: list[list[str]] = []
        cur: list[str] = []
        for i in range(len(refs) - 1):
            a, b = refs[i], refs[i + 1]
            pa, pb = nodes[a], nodes[b]
            seg = _clip_segment(bb, pa, pb)
            if seg is None:
                if cur:
                    runs.append(cur)
                    cur = []
                continue
            t0, t1 = seg
            if not cur:
                if t0 <= 0.0 and bb.inside(*pa):
                    cur = [a]
                else:
                    cur = [make_node(pa[0] + t0 * (pb[0] - pa[0]), pa[1] + t0 * (pb[1] - pa[1]))]
            if t1 >= 1.0 and bb.inside(*pb):
                cur.append(b)
            else:
                cur.append(make_node(pa[0] + t1 * (pb[0] - pa[0]), pa[1] + t1 * (pb[1] - pa[1])))
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        runs = [r for r in runs if len(r) >= 2]
        cut = not (len(runs) == 1 and runs[0] == refs)
        if cut:
            short = [r for r in runs if _run_length(r, nodes, new_nodes) < MIN_CUT_RUN_M]
            stats["short_runs_dropped"] = stats.get("short_runs_dropped", 0) + len(short)
            runs = [r for r in runs if r not in short]
        if not runs:
            stats["ways_dropped"] += 1
            continue
        whole = len(runs) == 1 and runs[0] == refs and len(refs) == len(w.findall("nd"))
        stats["ways_kept_whole" if whole else "ways_split"] += 1
        for k, run in enumerate(runs):
            stats["runs"] += 1
            wid = w.get("id") if len(runs) == 1 else str(int(w.get("id")) * SPLIT_WAY_FACTOR + k + 1)
            ew = ET.Element("way", {"id": wid, "version": w.get("version", "1")})
            for r in run:
                ET.SubElement(ew, "nd", {"ref": r})
                used_nodes.add(r)
            for t in tags:
                ET.SubElement(ew, "tag", dict(t.attrib))
            ET.SubElement(ew, "tag", {"k": "weave:way", "v": w.get("id")})
            kept_ways.append(ew)

    for n in root.findall("node"):
        if n.get("id") in used_nodes:
            out_root.append(n)
    for nid, lat, lon in new_nodes:
        if nid in used_nodes:
            ET.SubElement(out_root, "node", {"id": nid, "version": "1",
                                             "lat": f"{lat:.7f}", "lon": f"{lon:.7f}"})
    for w in kept_ways:
        out_root.append(w)
    dst.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(out_root).write(dst, encoding="utf-8", xml_declaration=True)
    stats["boundary_nodes"] = len(new_nodes)
    return stats


def way_tags(path: Path) -> dict[str, dict[str, str]]:
    """Tags of every way in an OSM file, keyed by way id."""
    out: dict[str, dict[str, str]] = {}
    for w in ET.parse(path).getroot().findall("way"):
        out[w.get("id")] = {t.get("k"): t.get("v") for t in w.findall("tag")}
    return out


def way_geometry(path: Path) -> tuple[dict[str, list[str]], dict[str, tuple[float, float]]]:
    """(way id → node refs, node id → (lat, lon)) of an OSM file."""
    root = ET.parse(path).getroot()
    nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.findall("node")}
    ways = {w.get("id"): [nd.get("ref") for nd in w.findall("nd")] for w in root.findall("way")}
    return ways, nodes
