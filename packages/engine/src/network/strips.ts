/** Lateral strips (docs/MODEL.md §1.5). Strips tile the carriageway exactly. */

export interface StripLayout {
  /** Number of strips. */
  n: number;
  /** Strip width (m) = roadWidth / n. */
  w: number;
}

export function stripLayout(roadWidthM: number, targetStripM: number): StripLayout {
  const n = Math.max(1, Math.floor(roadWidthM / targetStripM + 0.5));
  return { n, w: roadWidthM / n };
}

function clampIdx(k: number, n: number): number {
  return k < 0 ? 0 : k > n - 1 ? n - 1 : k;
}

/** Inclusive strip span of [left, right). */
function span(left: number, right: number, layout: StripLayout): [number, number] {
  const lo = clampIdx(Math.floor(left / layout.w), layout.n);
  const hi = clampIdx(Math.ceil(right / layout.w) - 1, layout.n);
  return [lo, hi];
}

export function occupiedStrips(yCentre: number, width: number, clearance: number, layout: StripLayout): [number, number] {
  const half = width / 2 + clearance;
  return span(yCentre - half, yCentre + half, layout);
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
