import type { Conflict, ConflictType, Movement, Network } from '../schema/network.ts';

/**
 * Conflict areas between movements at the same node (docs/MODEL.md §3.1). The interval on m
 * against m′ is the set of arc lengths whose cross-section (perpendicular, width_m wide)
 * intersects ribbon(m′) = points within width_m′/2 of m′'s centreline. Sampled every 0.25 m
 * along the path and at 9 points across it, then widened by one sample spacing so the result
 * over-approximates. Two straight ribbons crossing at θ give w₂/sin θ + w₁·|cot θ|.
 */

const DS = 0.25;
const LATERAL_SAMPLES = 9;

type Pt = readonly [number, number];

interface Path {
  pts: readonly Pt[];
  cum: number[];
  length: number;
}

function toPath(pts: readonly Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dy = pts[i]![1] - pts[i - 1]![1];
    cum.push(cum[i - 1]! + Math.sqrt(dx * dx + dy * dy));
  }
  return { pts, cum, length: cum[cum.length - 1]! };
}

/** Point and unit left normal at arc length s. */
function frame(p: Path, s: number): { x: number; y: number; nx: number; ny: number } {
  const { pts, cum } = p;
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1]! < s) i++;
  // skip zero-length segments for the tangent
  let j = i;
  while (j < pts.length - 2 && cum[j + 1]! - cum[j]! < 1e-12) j++;
  const a = pts[j]!;
  const b = pts[j + 1]!;
  const segLen = cum[j + 1]! - cum[j]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  const f = segLen > 0 ? Math.min(Math.max((s - cum[j]!) / segLen, 0), 1) : 0;
  return { x: a[0] + dx * f, y: a[1] + dy * f, nx: -dy / l, ny: dx / l };
}

function distToPath(p: Path, x: number, y: number): number {
  let best = Infinity;
  const pts = p.pts;
  if (pts.length === 1) return Math.hypot(x - pts[0]![0], y - pts[0]![1]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a[0] + t * dx - x;
    const ey = a[1] + t * dy - y;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best;
}

/** Arc-length interval on `a` whose cross-sections meet ribbon(b), or null. */
function interval(a: Path, wa: number, b: Path, wb: number): [number, number] | null {
  const half = wb / 2;
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.max(1, Math.ceil(a.length / DS));
  for (let k = 0; k <= n; k++) {
    const s = a.length === 0 ? 0 : Math.min((k * a.length) / n, a.length);
    const f = frame(a, s);
    for (let q = 0; q < LATERAL_SAMPLES; q++) {
      const u = -wa / 2 + (q * wa) / (LATERAL_SAMPLES - 1);
      if (distToPath(b, f.x + f.nx * u, f.y + f.ny * u) <= half) {
        if (s < lo) lo = s;
        if (s > hi) hi = s;
        break;
      }
    }
    if (a.length === 0) break;
  }
  if (lo === Infinity) return null;
  const step = a.length / n;
  return [Math.max(0, lo - step), Math.min(a.length, hi + step)];
}

function typeOf(a: Movement, b: Movement): ConflictType {
  if (a.toLink === b.toLink) return 'merging';
  if (a.fromLink === b.fromLink) return 'diverging';
  return 'crossing';
}

/**
 * Conflicts per movement id. Movements that already carry `conflicts` keep them; all other
 * pairs at the same node are computed (symmetrically).
 */
export function computeConflicts(net: Network): Map<string, Conflict[]> {
  const out = new Map<string, Conflict[]>();
  const byNode = new Map<string, Movement[]>();
  for (const m of net.movements) {
    out.set(m.id, m.conflicts ? [...m.conflicts] : []);
    const list = byNode.get(m.node) ?? [];
    list.push(m);
    byNode.set(m.node, list);
  }
  for (const list of byNode.values()) {
    const paths = list.map((m) => toPath(m.path as Pt[]));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.conflicts || b.conflicts) continue;
        const ia = interval(paths[i]!, a.widthM, paths[j]!, b.widthM);
        if (!ia) continue;
        const ib = interval(paths[j]!, b.widthM, paths[i]!, a.widthM);
        if (!ib) continue;
        const type = typeOf(a, b);
        out.get(a.id)!.push({ movement: b.id, type, self: ia, other: ib });
        out.get(b.id)!.push({ movement: a.id, type, self: ib, other: ia });
      }
    }
  }
  return out;
}

/** The network with every movement's `conflicts` filled in. */
export function withConflicts(net: Network): Network {
  const c = computeConflicts(net);
  return { ...net, movements: net.movements.map((m) => ({ ...m, conflicts: c.get(m.id) ?? [] })) };
}
