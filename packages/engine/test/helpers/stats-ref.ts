/**
 * Test-local statistics references, independent of src/stats.
 *
 * Student-t CDF via the exact finite series of Abramowitz & Stegun (1964) 26.7.3 (ν odd) and
 * 26.7.4 (ν even), with θ = atan(t/√ν):
 *   A(t|ν) = 2F(t) − 1 =
 *     ν = 1:      2θ/π
 *     ν odd ≥ 3:  (2/π)·[θ + sinθ·cosθ·(1 + (2/3)cos²θ + … + (2·4···(ν−3))/(1·3···(ν−2))·cos^{ν−3}θ)]
 *     ν even:     sinθ·(1 + (1/2)cos²θ + (1·3)/(2·4)cos⁴θ + … + (1·3···(ν−3))/(2·4···(ν−2))·cos^{ν−2}θ)
 * These are exact in real arithmetic (no quadrature, no incomplete beta), so in double
 * precision F is accurate to a few ulps, and bisection to 1e-13 inverts it.
 */
import { SignalPlan } from '../../src/schema/index.ts';

export function tCdfRef(t: number, nu: number): number {
  const th = Math.atan(t / Math.sqrt(nu));
  const s = Math.sin(th);
  const c = Math.cos(th);
  let A: number;
  if (nu % 2 === 1) {
    if (nu === 1) A = (2 * th) / Math.PI;
    else {
      let term = 1;
      let sum = 1;
      for (let k = 1; 2 * k + 1 <= nu - 2; k++) {
        term *= ((2 * k) / (2 * k + 1)) * c * c;
        sum += term;
      }
      A = (2 / Math.PI) * (th + s * c * sum);
    }
  } else {
    let term = 1;
    let sum = 1;
    for (let k = 1; 2 * k <= nu - 2; k++) {
      term *= ((2 * k - 1) / (2 * k)) * c * c;
      sum += term;
    }
    A = s * sum;
  }
  return 0.5 + A / 2;
}

/** Inverse of tCdfRef for p in (0.5, 1) by bisection to |Δt| < 1e-13·max(1, t). */
export function tQuantileRef(p: number, nu: number): number {
  let lo = 0;
  let hi = 1;
  while (tCdfRef(hi, nu) < p) hi *= 2;
  for (let i = 0; i < 400 && hi - lo > 1e-13 * Math.max(1, hi); i++) {
    const mid = 0.5 * (lo + hi);
    if (tCdfRef(mid, nu) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** §5.1 meanCI with the reference quantile. */
export function meanCIRef(xs: readonly number[], level = 0.95) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n >= 2 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (n - 1)) : NaN;
  const half = n >= 2 ? (tQuantileRef((1 + level) / 2, n - 1) * sd) / Math.sqrt(n) : Infinity;
  return { mean, half, lo: mean - half, hi: mean + half, n, sd };
}

/* ---------- Webster retiming (§5.3) ---------- */

export type Plan = ReturnType<typeof SignalPlan.parse>;

/**
 * Reference retiming: keep C and the per-phase lost time; G = C − Σ(amber + allRed);
 * y_p = max over the phase's protected movements of ratio (0 if none / missing);
 * g_p ∝ y_p, with phases that would fall below 5 s fixed at 5 s and the rest rescaled
 * (repeated until stable); equal split when Σy = 0.
 */
export function retimeRef(plan: Plan, ratio: Record<string, number>): number[] {
  const lost = plan.amberS + plan.allRedS;
  const C = plan.phases.reduce((a, ph) => a + ph.greenS + lost, 0);
  const G = C - plan.phases.length * lost;
  const y = plan.phases.map((ph) => Math.max(0, ...ph.protected.map((m) => ratio[m] ?? 0)));
  const Y = y.reduce((a, b) => a + b, 0);
  if (Y === 0) return plan.phases.map(() => G / plan.phases.length);
  const fixed = new Set<number>();
  for (;;) {
    const free = y.map((_, i) => i).filter((i) => !fixed.has(i));
    const Gfree = G - 5 * fixed.size;
    const Yfree = free.reduce((a, i) => a + y[i]!, 0);
    const g = y.map((yi, i) => (fixed.has(i) ? 5 : Yfree > 0 ? (Gfree * yi) / Yfree : Gfree / free.length));
    const newly = free.filter((i) => g[i]! < 5);
    if (newly.length === 0) return g;
    for (const i of newly) fixed.add(i);
  }
}

/** Standard normal pair by Box–Muller from two uniforms in [0, 1). */
export function boxMuller(u1: number, u2: number): [number, number] {
  const r = Math.sqrt(-2 * Math.log(1 - u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}
