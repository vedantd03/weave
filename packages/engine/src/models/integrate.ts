/**
 * Ballistic update with the stop condition (Treiber & Kanagaraj 2015; docs/MODEL.md §1.4).
 * A vehicle that would reach v < 0 within the step stops at x − v²/(2a) instead of reversing.
 */
export function ballistic(x: number, v: number, a: number, dt: number): { x: number; v: number } {
  const v1 = v + a * dt;
  if (v1 >= 0) return { x: x + v * dt + 0.5 * a * dt * dt, v: v1 };
  return { x: x - (v * v) / (2 * a), v: 0 };
}
