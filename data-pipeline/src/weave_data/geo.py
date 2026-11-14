"""Local planar coordinates and small polyline helpers.

Coordinates are local metres from an equirectangular projection around an origin
(lat0, lon0): x = R·(lon − lon0)·cos(lat0), y = R·(lat − lat0), x east, y north.
netconvert is run with the identical PROJ string (`+proj=eqc +lat_ts=lat0 +lat_0=lat0
+lon_0=lon0 +R=R`) so its output is already in these coordinates.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

EARTH_RADIUS_M = 6371008.8  # IUGG mean Earth radius

Point = tuple[float, float]


def proj_string(lat0: float, lon0: float) -> str:
    return (
        f"+proj=eqc +lat_ts={lat0} +lat_0={lat0} +lon_0={lon0} "
        f"+R={EARTH_RADIUS_M} +units=m +no_defs"
    )


def to_local(lat: float, lon: float, lat0: float, lon0: float) -> Point:
    k = math.pi / 180.0
    return (
        EARTH_RADIUS_M * (lon - lon0) * k * math.cos(lat0 * k),
        EARTH_RADIUS_M * (lat - lat0) * k,
    )


def polyline_length(pts: Sequence[Point]) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def dedupe(pts: Sequence[Point], eps: float = 1e-6) -> list[Point]:
    out: list[Point] = []
    for p in pts:
        if not out or math.dist(out[-1], p) > eps:
            out.append((float(p[0]), float(p[1])))
    return out


def resample(pts: Sequence[Point], n: int) -> list[Point]:
    """n points equally spaced in arc length along the polyline (n ≥ 2)."""
    pts = dedupe(pts)
    if len(pts) == 1:
        return [pts[0]] * n
    cum = [0.0]
    for i in range(len(pts) - 1):
        cum.append(cum[-1] + math.dist(pts[i], pts[i + 1]))
    total = cum[-1]
    out: list[Point] = []
    j = 0
    for k in range(n):
        s = total * k / (n - 1)
        while j < len(pts) - 2 and cum[j + 1] < s:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = 0.0 if seg <= 0 else min(1.0, max(0.0, (s - cum[j]) / seg))
        out.append((pts[j][0] + t * (pts[j + 1][0] - pts[j][0]),
                    pts[j][1] + t * (pts[j + 1][1] - pts[j][1])))
    return out


def left_normals(pts: Sequence[Point]) -> list[Point]:
    """Unit left normal (tangent rotated +90° CCW) at each vertex (averaged at interior vertices)."""
    n = len(pts)
    tang: list[Point] = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1.0
        tang.append((dx / d, dy / d))
    return [(-ty, tx) for tx, ty in tang]


def signed_offset(p: Point, line: Sequence[Point]) -> float:
    """Signed perpendicular distance of p from the polyline (positive = to the LEFT of travel)."""
    best = (math.inf, 0.0)
    for i in range(len(line) - 1):
        ax, ay = line[i]
        bx, by = line[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
        cx, cy = ax + t * dx, ay + t * dy
        d = math.dist(p, (cx, cy))
        if d < best[0]:
            cross = dx * (p[1] - ay) - dy * (p[0] - ax)
            best = (d, d if cross >= 0 else -d)
    return best[1]


def bearing_deg(a: Point, b: Point) -> float:
    """Compass bearing from a to b, degrees clockwise from north."""
    return (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360.0) % 360.0


def compass8(bearing: float) -> str:
    return ["n", "ne", "e", "se", "s", "sw", "w", "nw"][int(((bearing + 22.5) % 360) // 45)]
