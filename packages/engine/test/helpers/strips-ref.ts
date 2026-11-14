/**
 * Test-local reference of the strip rules (docs/MODEL.md §1.5) and the leader rule (§1.6),
 * written from the spec, independent of src/network/strips.ts and src/sim/leader.ts.
 */

export interface Layout {
  n: number;
  w: number;
  o: number;
}

/** Tolerance of the strip index, in units of strips (§1.5). */
export const STRIP_EPS = 1e-9;

/**
 * Strip-mode layout (§1.5, revised in M2): fixed strip width Δ, grid anchored at the left edge
 * and shifted by o ∈ [0, Δ). Boundaries {o + kΔ : 0 < o + kΔ < W} ∪ {0, W}; the first strip is
 * [0, o) when o > 0 and the last may be narrower than Δ.
 *   n = (o > 0 ? 1 : 0) + ceil((W − o)/Δ − 1e-9), n ≥ 1.
 * `origin` is reduced mod Δ; offsets within 1e-9 of 0 or Δ count as 0.
 */
export function layoutRef(roadWidthM: number, deltaM: number, origin = 0): Layout {
  let o = origin % deltaM;
  if (o < 0) o += deltaM;
  if (o < 1e-9 || deltaM - o < 1e-9) o = 0;
  const n = Math.max(1, (o > 0 ? 1 : 0) + Math.ceil((roadWidthM - o) / deltaM - STRIP_EPS));
  return { n, w: deltaM, o };
}

/** Lane mode: one strip per lane. */
export function laneLayoutRef(roadWidthM: number, lanes: number): Layout {
  return { n: lanes, w: roadWidthM / lanes, o: 0 };
}

const clamp = (k: number, n: number) => Math.min(n - 1, Math.max(0, k));
const first = (L: Layout) => (L.o > 0 ? 1 : 0);

/** stripIndex(x) = clamp(floor((x − o)/Δ + 1e-9) + (o > 0 ? 1 : 0), 0, n − 1). */
export function stripIndexRef(x: number, L: Layout): number {
  return clamp(Math.floor((x - L.o) / L.w + STRIP_EPS) + first(L), L.n);
}

/** Strip-mode occupancy: [left, right) = [y − width/2 − c, y + width/2 + c) in that order. */
export function occupiedRef(y: number, width: number, c: number, L: Layout): [number, number] {
  const left = y - width / 2 - c;
  const right = y + width / 2 + c;
  const hi = clamp(Math.ceil((right - L.o) / L.w - STRIP_EPS) - 1 + first(L), L.n);
  return [stripIndexRef(left, L), hi];
}

export function laneRef(y: number, L: Layout): [number, number] {
  const k = clamp(Math.floor(y / L.w), L.n);
  return [k, k];
}

/** Boundaries b_0 = 0 < b_1 < … < b_n = W of a layout (b_k is the start of strip k). */
export function boundariesRef(W: number, L: Layout): number[] {
  const b = [0];
  for (let k = 1; k < L.n; k++) b.push(L.o > 0 ? L.o + (k - 1) * L.w : k * L.w);
  b.push(W);
  return b;
}

export interface FixtureVehicle {
  id: number;
  frontM: number;
  lengthM: number;
  centreM: number;
  widthM: number;
  clearanceM: number;
}

export interface FixtureCase {
  name: string;
  why: string;
  roadWidthM: number;
  stripWidthM: number;
  mode: 'strip' | 'lane';
  lanes?: number;
  vehicles: FixtureVehicle[];
  expected: Record<string, number | null>;
}

/** Layout for a fixture case: strip mode Δ = stripWidthM with o = 0 (a link), lane mode one strip per lane. */
export function caseLayout(c: FixtureCase): Layout {
  if (c.mode === 'lane') return laneLayoutRef(c.roadWidthM, c.lanes!);
  return layoutRef(c.roadWidthM, c.stripWidthM);
}

export function caseStrips(c: FixtureCase): [number, number][] {
  const L = caseLayout(c);
  return c.vehicles.map((v) =>
    c.mode === 'lane' ? laneRef(v.centreM, L) : occupiedRef(v.centreM, v.widthM, v.clearanceM, L),
  );
}

export interface LeaderIn {
  front: number;
  length: number;
  lo: number;
  hi: number;
}

/** Brute-force leader rule, literally as worded in MODEL.md §1.6. */
export function leadersRef(vs: readonly LeaderIn[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < vs.length; i++) {
    const me = vs[i]!;
    let best = -1;
    let bestRear = Infinity;
    for (let j = 0; j < vs.length; j++) {
      if (j === i) continue;
      const o = vs[j]!;
      const overlap = o.lo <= me.hi && me.lo <= o.hi;
      const ahead = o.front > me.front || (o.front === me.front && j > i);
      if (!overlap || !ahead) continue;
      const rear = o.front - o.length;
      // strict < keeps the smaller index on ties because j increases
      if (rear < bestRear) {
        bestRear = rear;
        best = j;
      }
    }
    out.push(best);
  }
  return out;
}
