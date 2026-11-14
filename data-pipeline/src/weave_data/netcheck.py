"""Network checks: JSON Schema validity plus the cross-reference rules enforced by the TS zod
schema (packages/engine/src/schema/network.ts superRefine), and topology checks (D4)."""

from __future__ import annotations

import json
import math
from collections import defaultdict, deque

import jsonschema

from . import SCHEMA_DIR


def schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())


def schema_errors(obj: dict, name: str) -> list[str]:
    v = jsonschema.Draft202012Validator(schema(name))
    return [f"{'/'.join(map(str, e.path))}: {e.message}" for e in v.iter_errors(obj)]


def interval_errors(net: dict) -> list[str]:
    """zod Interval refine: lo <= hi."""
    out = []
    for m in net.get("movements", []):
        for k in ("fromLateral", "toLateral"):
            lo, hi = m[k]
            if lo > hi:
                out.append(f"movement {m['id']}: {k} lo > hi")
        for c in m.get("conflicts", []):
            for k in ("self", "other"):
                if c[k][0] > c[k][1]:
                    out.append(f"movement {m['id']}: conflict {k} lo > hi")
    return out


def crossref_errors(net: dict) -> list[str]:
    """Port of the zod superRefine in packages/engine/src/schema/network.ts."""
    issues: list[str] = []

    def unique(kind: str, ids: list[str]) -> set[str]:
        seen: set[str] = set()
        for i in ids:
            if i in seen:
                issues.append(f"duplicate {kind} id: {i}")
            seen.add(i)
        return seen

    nodes = unique("node", [n["id"] for n in net["nodes"]])
    links = unique("link", [lk["id"] for lk in net["links"]])
    movs = unique("movement", [m["id"] for m in net.get("movements", [])])
    unique("zone", [z["id"] for z in net.get("zones", [])])
    for lk in net["links"]:
        if lk["from"] not in nodes:
            issues.append(f"link {lk['id']}: unknown from-node {lk['from']}")
        if lk["to"] not in nodes:
            issues.append(f"link {lk['id']}: unknown to-node {lk['to']}")
    by_id = {lk["id"]: lk for lk in net["links"]}
    for m in net.get("movements", []):
        if m["node"] not in nodes:
            issues.append(f"movement {m['id']}: unknown node {m['node']}")
        f, t = by_id.get(m["fromLink"]), by_id.get(m["toLink"])
        if f is None:
            issues.append(f"movement {m['id']}: unknown fromLink {m['fromLink']}")
        if t is None:
            issues.append(f"movement {m['id']}: unknown toLink {m['toLink']}")
        if f is not None and f["to"] != m["node"]:
            issues.append(f"movement {m['id']}: fromLink does not end at node")
        if t is not None and t["from"] != m["node"]:
            issues.append(f"movement {m['id']}: toLink does not start at node")
        for c in m.get("conflicts", []):
            if c["movement"] not in movs:
                issues.append(f"movement {m['id']}: conflict with unknown {c['movement']}")
    for s in net.get("signals", []):
        if s["node"] not in nodes:
            issues.append(f"signal plan: unknown node {s['node']}")
        for p in s["phases"]:
            for i in [*p["protected"], *p.get("permissive", [])]:
                if i not in movs:
                    issues.append(f"signal plan {s['node']}: unknown movement {i}")
    for z in net.get("zones", []):
        if z["link"] not in links:
            issues.append(f"zone {z['id']}: unknown link {z['link']}")
    return issues


def contract_errors(net: dict) -> list[str]:
    return schema_errors(net, "network") + interval_errors(net) + crossref_errors(net)


# ---------------------------------------------------------------------------------------------
# topology (D4)


def link_graph(net: dict) -> dict[str, set[str]]:
    g: dict[str, set[str]] = defaultdict(set)
    for m in net.get("movements", []):
        g[m["fromLink"]].add(m["toLink"])
    return g


def reachable(g: dict[str, set[str]], start: str) -> set[str]:
    seen = {start}
    q = deque([start])
    while q:
        u = q.popleft()
        for v in g.get(u, ()):
            if v not in seen:
                seen.add(v)
                q.append(v)
    return seen


def weak_components(net: dict) -> list[set[str]]:
    und: dict[str, set[str]] = defaultdict(set)
    for lk in net["links"]:
        und[lk["id"]]
    for m in net.get("movements", []):
        und[m["fromLink"]].add(m["toLink"])
        und[m["toLink"]].add(m["fromLink"])
    comps, seen = [], set()
    for lid in und:
        if lid in seen:
            continue
        c = reachable(und, lid)
        seen |= c
        comps.append(c)
    return sorted(comps, key=len, reverse=True)


def polyline_len(pts) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def is_ramp(lk: dict, tol: float = 0.5) -> bool:
    return abs(lk.get("zFromM", 0.0) - lk.get("zToM", 0.0)) > tol


def level_errors(net: dict, layer_h: float, tol: float = 0.75) -> list[str]:
    """Flyover separation: every movement joins links at matching elevation, and a movement
    whose two links are on different layers involves at least one ramp (a link whose
    elevation changes). So a flat deck link is never joined directly to a flat ground link."""
    by_id = {lk["id"]: lk for lk in net["links"]}
    out = []
    for m in net.get("movements", []):
        f, t = by_id[m["fromLink"]], by_id[m["toLink"]]
        zf, zt = f.get("zToM", 0.0), t.get("zFromM", 0.0)
        if abs(zf - zt) > tol:
            out.append(f"movement {m['id']}: elevation jump {zf:.2f} → {zt:.2f} m")
        if f.get("layer", 0) != t.get("layer", 0) and not (is_ramp(f) or is_ramp(t)):
            flat_f = round(f.get("zToM", 0.0) / layer_h)
            flat_t = round(t.get("zFromM", 0.0) / layer_h)
            if flat_f != flat_t:
                out.append(f"movement {m['id']}: joins layer {f.get('layer', 0)} and "
                           f"{t.get('layer', 0)} without a ramp")
    return out
