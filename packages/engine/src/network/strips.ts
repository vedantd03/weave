/**
 * Lateral strips (docs/MODEL.md §1.5, revised in M2). Strip mode uses a fixed strip width Δ
 * anchored at the segment's left edge with origin offset o, so grids on kerb-aligned segments
 * coincide and movement grids continue their approach link's grid.
 */

export interface StripLayout {
  /** Number of strips. */
  n: number;
  /** Strip width Δ (the first and last strips may be narrower). */
  w: number;
  /** Grid origin offset in [0, w): boundaries at o + kΔ. */
  o: number;
}

const TOL = 1e-9;

export function stripLayout(roadWidthM: number, stripM: number, originM = 0): StripLayout {
  let o = originM - stripM * Math.floor(originM / stripM);
  if (o < TOL || stripM - o < TOL) o = 0;
  const first = o > 0 ? 1 : 0;
  const rest = Math.ceil((roadWidthM - o) / stripM - TOL);
  return { n: Math.max(1, first + Math.max(0, rest)), w: stripM, o };
}

export function laneLayout(roadWidthM: number, lanes: number): StripLayout {
  const n = Math.max(1, lanes);
  return { n, w: roadWidthM / n, o: 0 };
}

function clampIdx(k: number, n: number): number {
  return k < 0 ? 0 : k > n - 1 ? n - 1 : k;
}

/** Strip containing lateral position x. */
export function stripIndex(x: number, layout: StripLayout): number {
  const shift = layout.o > 0 ? 1 : 0;
  return clampIdx(Math.floor((x - layout.o) / layout.w + TOL) + shift, layout.n);
}

/** Inclusive strip span of [left, right). */
function span(left: number, right: number, layout: StripLayout): [number, number] {
  const shift = layout.o > 0 ? 1 : 0;
  const lo = stripIndex(left, layout);
  const hi = clampIdx(Math.ceil((right - layout.o) / layout.w - TOL) - 1 + shift, layout.n);
  return [lo, hi < lo ? lo : hi];
}

export function occupiedStrips(yCentre: number, width: number, clearance: number, layout: StripLayout): [number, number] {
  // Evaluated exactly as written in MODEL.md §1.5 (left = y − width/2 − c).
  return span(yCentre - width / 2 - clearance, yCentre + width / 2 + clearance, layout);
}

export function sweptStrips(yA: number, yB: number, width: number, clearance: number, layout: StripLayout): [number, number] {
  const a = occupiedStrips(yA, width, clearance, layout);
  const b = occupiedStrips(yB, width, clearance, layout);
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

export function laneStrip(yCentre: number, layout: StripLayout): [number, number] {
  const k = clampIdx(Math.floor(yCentre / layout.w), layout.n);
  return [k, k];
}
