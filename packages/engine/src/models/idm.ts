/** Intelligent Driver Model (docs/MODEL.md §1.3). Uses only + − × ÷ sqrt (deterministic). */

export interface IdmParams {
  v0: number;
  T: number;
  s0: number;
  a: number;
  b: number;
}

/** Physical braking limit (m/s²). */
export const B_MAX = 9;

/**
 * IDM acceleration. `gap` is the net gap to the leader's rear (Infinity with no leader);
 * `dv = v − v_leader` is the approach rate. Clamped to [−B_MAX, a].
 */
export function idmAccel(p: IdmParams, v: number, gap: number, dv: number): number {
  if (gap <= 0) return -B_MAX;
  const r = v / p.v0;
  const r2 = r * r;
  const free = 1 - r2 * r2;
  let acc: number;
  if (gap === Infinity) {
    acc = p.a * free;
  } else {
    const dyn = v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b));
    const sStar = p.s0 + (dyn > 0 ? dyn : 0);
    const q = sStar / gap;
    acc = p.a * (free - q * q);
  }
  if (acc < -B_MAX) return -B_MAX;
  if (acc > p.a) return p.a;
  return acc;
}
