/** Test-local copy of the ballistic update of docs/MODEL.md §1.4 (not the engine's). */
export function ballisticRef(x: number, v: number, a: number, dt: number): { x: number; v: number } {
  if (v + a * dt >= 0) return { x: x + v * dt + 0.5 * a * dt * dt, v: v + a * dt };
  return { x: x - (v * v) / (2 * a), v: 0 };
}
