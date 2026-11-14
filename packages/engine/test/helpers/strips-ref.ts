/**
 * Test-local reference of the strip rules (docs/MODEL.md §1.5) and the leader rule (§1.6),
 * written from the spec, independent of src/network/strips.ts and src/sim/leader.ts.
 */

export interface Layout {
  n: number;
  w: number;
}

export function layoutRef(roadWidthM: number, targetStripM: number): Layout {
  const n = Math.max(1, Math.round(roadWidthM / targetStripM));
  return { n, w: roadWidthM / n };
}

const clamp = (k: number, n: number) => Math.min(n - 1, Math.max(0, k));

/** Strip-mode occupancy: [left, right) = [y − width/2 − c, y + width/2 + c). */
export function occupiedRef(y: number, width: number, c: number, L: Layout): [number, number] {
  const left = y - width / 2 - c;
  const right = y + width / 2 + c;
  return [clamp(Math.floor(left / L.w), L.n), clamp(Math.ceil(right / L.w) - 1, L.n)];
}

export function laneRef(y: number, L: Layout): [number, number] {
  const k = clamp(Math.floor(y / L.w), L.n);
  return [k, k];
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

/** Layout for a fixture case: strip mode uses stripWidthM, lane mode uses roadWidthM / lanes. */
export function caseLayout(c: FixtureCase): Layout {
  if (c.mode === 'lane') return layoutRef(c.roadWidthM, c.roadWidthM / c.lanes!);
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
