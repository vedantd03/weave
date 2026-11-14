/**
 * T3 — approach to a standing obstacle: idmAccel (§1.3) composed with ballistic (§1.4) in a
 * test-owned loop (the step loop of MODEL.md §1.7 for one follower and a fixed leader with
 * v_leader = 0, so dv = v).
 *
 * What theory says (derivations in the comments below):
 *  - At rest, a(g, 0, 0) = a(1 − (s0/g)²) is > 0 for g > s0 and < 0 for g < s0, and with
 *    v = 0, a < 0 the stop branch leaves x unchanged. So the only possible resting states have
 *    g ≤ s0, and a vehicle resting with g > s0 always moves on.
 *  - Near (g, v) = (s0, 0) the IDM linearises to a damped oscillator for d = g − s0:
 *      acc ≈ (2a/s0)·d − (2aT/s0)·v,  i.e.  ω² = 2a/s0,  ζ = T·√(a/(2·s0)).
 *    For ζ ≥ 1 the final approach is non-oscillatory: the trajectory runs in along the slow
 *    eigen-direction v ≈ k·d with k = ω(ζ − √(ζ² − 1)) and creeps up to s0 from above.
 *    Crossing s0 in one step would need v·dt > d, i.e. k·dt > 1, which is false here.
 *    A crossing step with acc ≥ 0 is impossible outright when a·dt² < s0 and T > dt:
 *    acc ≥ 0 needs u := g − s0 − vT ≥ 0 and gives acc ≤ 2a·u/s0. Then g' < s0 needs
 *    u + v(T − dt) < ½·acc·dt² ≤ a·u·dt²/s0, i.e. u(1 − a·dt²/s0) + v(T − dt) < 0, which
 *    cannot hold.
 */
import { describe, expect, it } from 'vitest';
import { idmAccel, type IdmParams } from '../../src/models/idm.ts';
import { ballistic } from '../../src/models/integrate.ts';

const DT = 0.2;

function approach(p: IdmParams, v0: number, X: number, steps: number) {
  let x = 0;
  let v = v0;
  let minGap = X;
  let stoppedAt = -1;
  for (let n = 0; n < steps; n++) {
    const g = X - x;
    const acc = idmAccel(p, v, g, v - 0);
    const r = ballistic(x, v, acc, DT);
    x = r.x;
    v = r.v;
    minGap = Math.min(minGap, X - x);
    if (v === 0 && stoppedAt < 0) stoppedAt = n;
  }
  return { gap: X - x, v, minGap, stoppedAt };
}

/** Linearised discrete map at (d, v) = (0, 0) for the ballistic update; returns its eigenvalues. */
function linearEigen(p: IdmParams, dt: number): { l1: number; l2: number; real: boolean } {
  const al = (2 * p.a) / p.s0;
  const be = (2 * p.a * p.T) / p.s0;
  // d' = d − v·dt − ½·acc·dt²,  v' = v + acc·dt,  acc = al·d − be·v
  const m11 = 1 - 0.5 * al * dt * dt;
  const m12 = -dt + 0.5 * be * dt * dt;
  const m21 = al * dt;
  const m22 = 1 - be * dt;
  const tr = m11 + m22;
  const det = m11 * m22 - m12 * m21;
  const disc = tr * tr - 4 * det;
  if (disc < 0) return { l1: Math.sqrt(det), l2: Math.sqrt(det), real: false };
  return { l1: (tr + Math.sqrt(disc)) / 2, l2: (tr - Math.sqrt(disc)) / 2, real: true };
}

describe('T3 follower approaching a standing obstacle', () => {
  // ζ = 2·√(2/(2·2)) = 1.414 (overdamped); a·dt² = 0.08 < s0 = 2; T = 2 > dt.
  const P: IdmParams = { v0: 15, T: 2, s0: 2, a: 2, b: 2 };

  it('premises of the derivation hold for the chosen parameters', () => {
    const zeta = P.T * Math.sqrt(P.a / (2 * P.s0));
    expect(zeta).toBeGreaterThanOrEqual(1.2);
    expect(P.a * DT * DT).toBeLessThan(P.s0);
    expect(P.T).toBeGreaterThan(DT);
    const k = Math.sqrt((2 * P.a) / P.s0) * (zeta - Math.sqrt(zeta * zeta - 1));
    expect(k * DT).toBeLessThan(1);
    const e = linearEigen(P, DT);
    expect(e.real).toBe(true);
    expect(e.l1).toBeGreaterThan(0);
    expect(e.l2).toBeGreaterThan(0);
    expect(e.l1).toBeLessThan(1);
  });

  // Initial gaps X ≥ s0 + vT + v²/(2b) (the IDM's own comfortable stopping need, 88 m at 15 m/s).
  const starts: [number, number][] = [
    [0, 100],
    [0, 300],
    [5, 100],
    [10, 100],
    [15, 100],
    [15, 300],
  ];

  for (const [v0, X] of starts) {
    it(`from v = ${v0} m/s at gap ${X} m: gap stays ≥ s0 and settles to s0`, () => {
      expect(X).toBeGreaterThanOrEqual(P.s0 + v0 * P.T + (v0 * v0) / (2 * P.b));
      // 2000 s of simulated time. Settling: the slowest linear mode decays as l1^n; we need
      // K·X·l1^n ≤ 1e-9 m with a generous non-normal/nonlinear entry factor K = 1e6.
      const n = 10_000;
      const { l1 } = linearEigen(P, DT);
      expect(1e6 * X * Math.pow(l1, n)).toBeLessThan(1e-9);
      const r = approach(P, v0, X, n);
      // Lower bound: no crossing below s0 (argument in the header). Slack 1e-9 m absorbs
      // rounding of X − x (ulp(300) ≈ 6e-14) many times over.
      expect(r.minGap).toBeGreaterThanOrEqual(P.s0 - 1e-9);
      // Settled: |g − s0| ≤ 1e-9 m (the decay bound above), and the speed has died out.
      // (v ≈ k·d along the slow direction, so v ≤ k·1e-9 < 1e-9 m/s.)
      expect(Math.abs(r.gap - P.s0)).toBeLessThanOrEqual(1e-9);
      expect(r.v).toBeLessThanOrEqual(1e-9);
    });
  }

  it('underdamped driver (ζ < 1): never collides; comes to rest at a gap in (0, s0]', () => {
    // ζ = 1·√(0.3/4) = 0.27: the linear approach overshoots s0, and the vehicle freezes at
    // the first stop with g < s0 (resting states must have g ≤ s0, see header). Rigorous
    // statements only: no collision (gap > 0 throughout), final state at rest, gap ≤ s0.
    const U: IdmParams = { v0: 20, T: 1, s0: 2, a: 0.3, b: 3 };
    for (const [v0, X] of [
      [0, 100],
      [10, 100],
      [20, 200],
    ] as [number, number][]) {
      expect(X).toBeGreaterThanOrEqual(U.s0 + v0 * U.T + (v0 * v0) / (2 * U.b));
      const r = approach(U, v0, X, 10_000);
      expect(r.minGap).toBeGreaterThan(0);
      expect(Math.abs(r.v)).toBe(0); // frozen by the stop branch (v' = 0 exactly)
      expect(r.gap).toBeLessThanOrEqual(U.s0);
      expect(r.gap).toBeGreaterThan(0);
    }
  });

  it('a vehicle at rest beyond s0 creeps forward; at rest inside s0 it stays put', () => {
    // a(g, 0, 0) = a(1 − (s0/g)²): positive at g = 5, negative at g = 1.5.
    const fwd = ballistic(0, 0, idmAccel(P, 0, 5, 0), DT);
    expect(fwd.x).toBeGreaterThan(0);
    expect(fwd.v).toBeCloseTo(P.a * (1 - (P.s0 / 5) ** 2) * DT, 12);
    const stay = ballistic(0, 0, idmAccel(P, 0, 1.5, 0), DT);
    expect(stay.x).toBe(0);
    expect(Math.abs(stay.v)).toBe(0);
  });
});
