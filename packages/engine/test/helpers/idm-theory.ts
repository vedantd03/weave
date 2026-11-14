/**
 * Test-local IDM theory (docs/MODEL.md §1.3), written independently of src/models/idm.ts.
 * Tests use these to compute expected values; they never call the engine's idmAccel for that.
 */

export interface Idm {
  v0: number;
  T: number;
  s0: number;
  a: number;
  b: number;
}

/** B_MAX from MODEL.md §1.3 (physical braking limit). */
export const B_MAX_SPEC = 9;

/** The IDM acceleration exactly as written in MODEL.md §1.3 (formula + clamp). */
export function idmRef(p: Idm, v: number, gap: number, dv: number): number {
  if (gap <= 0) return -B_MAX_SPEC;
  const r = v / p.v0;
  const r2 = r * r;
  const free = 1 - r2 * r2;
  let acc: number;
  if (gap === Infinity) {
    acc = p.a * free;
  } else {
    const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
    const q = sStar / gap;
    acc = p.a * (free - q * q);
  }
  return Math.min(p.a, Math.max(-B_MAX_SPEC, acc));
}

/** Equilibrium gap s_e(v) = (s0 + vT) / sqrt(1 - (v/v0)^4)  (MODEL.md §1.3), for 0 <= v < v0. */
export function equilibriumGap(p: Idm, v: number): number {
  const r = v / p.v0;
  const r2 = r * r;
  return (p.s0 + v * p.T) / Math.sqrt(1 - r2 * r2);
}

/**
 * Equilibrium speed for a given net gap: solves s_e(v) = gap by bisection on [0, v0).
 * s_e is strictly increasing from s0 (v = 0) to +inf (v -> v0), so the root is unique for
 * gap > s0. 200 halvings shrink the bracket below one ulp of v0, so the result is exact to
 * double precision (we stop when the midpoint no longer changes).
 */
export function equilibriumSpeed(p: Idm, gap: number): number {
  if (!(gap > p.s0)) throw new Error(`gap ${gap} must exceed s0 ${p.s0}`);
  let lo = 0;
  let hi = p.v0;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (equilibriumGap(p, mid) < gap) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Analytic partial derivatives of the (unclamped) IDM acceleration a(s, v, dv) at the
 * equilibrium point (s = s_e(v), dv = 0), with dv = v - v_leader as in MODEL.md §1.3.
 *
 *   a(s,v,dv) = a [ 1 - (v/v0)^4 - (sStar/s)^2 ],  sStar = s0 + vT + v dv / (2 sqrt(ab))
 *   a_s  = 2 a sStar^2 / s^3                                  (> 0)
 *   a_v  = -a [ 4 v^3 / v0^4 + 2 sStar T / s^2 ]              (< 0; at dv = 0, dsStar/dv = T)
 *   a_dv = -a sStar v / ( s^2 sqrt(ab) )                      (< 0; dsStar/d(dv) = v / (2 sqrt(ab)))
 *
 * (At dv = 0 and v > 0 the argument of max(0, .) is vT > 0, so the max is inactive and the
 * function is differentiable there.)
 */
export function idmPartials(p: Idm, v: number): { as: number; av: number; adv: number; s: number } {
  const s = equilibriumGap(p, v);
  const sStar = p.s0 + v * p.T;
  const as = (2 * p.a * sStar * sStar) / (s * s * s);
  const av = -p.a * ((4 * v * v * v) / Math.pow(p.v0, 4) + (2 * sStar * p.T) / (s * s));
  const adv = (-p.a * sStar * v) / (s * s * Math.sqrt(p.a * p.b));
  return { as, av, adv, s };
}

/**
 * Long-wavelength (continuous-time) string-stability margin.
 *
 * Linearise a_n = f(s_n, v_n, dv_n) around the uniform flow. In the convention of Wilson &
 * Ward (2011) and Treiber & Kesting (2013, ch. 15), with the relative speed taken as
 * Δv_WW = v_leader - v (so f_Δv > 0), the uniform flow is string stable iff
 *
 *     f_v^2 / 2 - f_Δv f_v - f_s > 0.
 *
 * MODEL.md uses dv = v - v_leader = -Δv_WW, so a_dv = -f_Δv and the criterion reads
 *
 *     S = a_v^2 / 2 + a_v a_dv - a_s > 0      (string stable).
 *
 * We re-derived it here rather than trusting a sign from memory: for perturbations
 * y_n ~ exp(λt + i n θ) with the leader carrying phase e^{iθ}, the branch with λ(0) = 0 is
 * λ = iθ λ1 + θ² λ2 + O(θ³) with λ1 = -a_s/a_v ... and Re λ = θ² λ2 < 0 exactly when S > 0.
 * Sanity check: for the optimal-velocity model a = (V(s) - v)/τ this gives V'(s) < 1/(2τ),
 * Bando et al.'s (1995) classic condition.
 */
export function stringStabilityMargin(p: Idm, v: number): number {
  const { as, av, adv } = idmPartials(p, v);
  return (av * av) / 2 + av * adv - as;
}

/* ---------- minimal complex arithmetic for the discrete-time ring analysis ---------- */
interface C {
  re: number;
  im: number;
}
const c = (re: number, im = 0): C => ({ re, im });
const add = (x: C, y: C): C => c(x.re + y.re, x.im + y.im);
const sub = (x: C, y: C): C => c(x.re - y.re, x.im - y.im);
const mul = (x: C, y: C): C => c(x.re * y.re - x.im * y.im, x.re * y.im + x.im * y.re);
const scale = (x: C, k: number): C => c(x.re * k, x.im * k);
const abs = (x: C): number => Math.hypot(x.re, x.im);
function csqrt(x: C): C {
  const r = abs(x);
  const re = Math.sqrt((r + x.re) / 2);
  const im = Math.sqrt(Math.max(0, (r - x.re) / 2));
  return c(re, x.im < 0 ? -im : im);
}

/**
 * Exact linear stability of the *discrete* ring as simulated: N identical vehicles, IDM,
 * synchronous update with the ballistic scheme of MODEL.md §1.4 (normal-step branch, which
 * applies near a uniform flow with v_e > 0).
 *
 * Per Fourier mode k (leader perturbation = z * own, z = e^{2πik/N}), the state (y, w) =
 * (position, speed perturbation) evolves as
 *   α  = a_s (z - 1) y + (a_v + a_dv (1 - z)) w
 *   y' = y + dt w + dt²/2 α,    w' = w + dt α,
 * i.e. a 2x2 complex matrix M_k. Returns
 *   - maxRingRadius: max over k = 1..N-1 of the spectral radius of M_k (relative motion),
 *   - uniformFactor: |1 + dt a_v|, the speed eigenvalue of the k = 0 mode (all vehicles
 *     together relaxing to v_e; the other k = 0 eigenvalue is the neutral translation 1).
 * The speeds converge to v_e iff both are < 1; perturbations grow iff maxRingRadius > 1.
 * This captures both the finite-N and the dt = 0.2 s effects on the stability boundary.
 */
export function discreteRingStability(
  p: Idm,
  v: number,
  N: number,
  dt: number,
): { maxRingRadius: number; uniformFactor: number; rate: number } {
  const { as, av, adv } = idmPartials(p, v);
  let maxR = 0;
  for (let k = 1; k < N; k++) {
    const th = (2 * Math.PI * k) / N;
    const z = c(Math.cos(th), Math.sin(th));
    const A = scale(sub(z, c(1)), as); // coefficient of y in α
    const B = add(c(av), scale(sub(c(1), z), adv)); // coefficient of w in α
    const h = (dt * dt) / 2;
    const m11 = add(c(1), scale(A, h));
    const m12 = add(c(dt), scale(B, h));
    const m21 = scale(A, dt);
    const m22 = add(c(1), scale(B, dt));
    const tr = add(m11, m22);
    const det = sub(mul(m11, m22), mul(m12, m21));
    const disc = csqrt(sub(mul(tr, tr), scale(det, 4)));
    const mu1 = scale(add(tr, disc), 0.5);
    const mu2 = scale(sub(tr, disc), 0.5);
    maxR = Math.max(maxR, abs(mu1), abs(mu2));
  }
  const uniformFactor = Math.abs(1 + dt * av);
  return { maxRingRadius: maxR, uniformFactor, rate: Math.max(maxR, uniformFactor) };
}
