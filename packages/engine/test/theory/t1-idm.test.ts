/**
 * T1 — IDM acceleration (docs/MODEL.md §1.3).
 * Expected values are the spec formulas written out in this file (Treiber, Hennecke & Helbing,
 * 2000, with δ = 4), never the engine's idmAccel.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { B_MAX, idmAccel, type IdmParams } from '../../src/models/idm.ts';
import { EPS } from '../helpers/numeric.ts';

const P: IdmParams = { v0: 15, T: 1.5, s0: 2, a: 1, b: 1.5 };

/**
 * Floating-point tolerance for comparing two evaluations of a·(free − q²) that may use a
 * different but equivalent operation order. Each of free and q² = (sStar/gap)² is produced by at
 * most ~6 correctly rounded operations (r = v/v0, r², r⁴, 1 − r⁴; vT, v·dv, √(ab), 2√(ab),
 * division, sum, max, sStar/gap, square), so each carries a relative error ≤ 8·EPS/2 = 4·EPS
 * (generous: 8 roundings of ≤ EPS/2). The final difference and multiplication by a add 2 more.
 * Absolute bound: a·(|free| + q²)·8·EPS. Clamping to [−B_MAX, a] is 1-Lipschitz, so the bound
 * survives it. A wrong formula changes the result by orders of magnitude more.
 */
function tol(p: IdmParams, v: number, gap: number, dv: number): number {
  const r = v / p.v0;
  const free = Math.abs(1 - r * r * r * r);
  let q2 = 0;
  if (Number.isFinite(gap) && gap > 0) {
    const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
    q2 = (sStar / gap) ** 2;
  }
  return p.a * (free + q2) * 8 * EPS + Number.MIN_VALUE;
}

describe('T1 IDM (MODEL.md §1.3)', () => {
  it('B_MAX is the physical braking limit 9 m/s²', () => {
    expect(B_MAX).toBe(9);
  });

  it('free road (gap = Infinity): a·(1 − (v/v0)^4), independent of dv', () => {
    for (const v of [0, 1, 5, 7.5, 10, 14, 15, 16, 18]) {
      for (const dv of [-10, 0, 3, 20]) {
        const expected = Math.max(-9, P.a * (1 - Math.pow(v / P.v0, 4)));
        // Math.pow vs r2*r2 may differ by a few ulp of r^4 (≤ 16 here); tol() covers 8·EPS·a·(|free|).
        expect(Math.abs(idmAccel(P, v, Infinity, dv) - expected)).toBeLessThanOrEqual(tol(P, v, Infinity, dv) + 16 * 4 * EPS);
      }
    }
    expect(idmAccel(P, 0, Infinity, 0)).toBe(P.a); // 1 − 0 = 1 exactly
    expect(Math.abs(idmAccel(P, P.v0, Infinity, 0))).toBeLessThanOrEqual(4 * EPS); // r = 1 exactly → 0
  });

  it('free road above v0 is negative and clamped at −B_MAX for large overspeed', () => {
    // v = 2·v0: a(1 − 16) = −15 m/s² < −9 → clamp.
    expect(idmAccel(P, 2 * P.v0, Infinity, 0)).toBe(-9);
    // v = 1.2·v0: a(1 − 2.0736) = −1.0736 (inside the clamp).
    const v = 1.2 * P.v0;
    const r = v / P.v0;
    expect(Math.abs(idmAccel(P, v, Infinity, 0) - P.a * (1 - r * r * r * r))).toBeLessThanOrEqual(tol(P, v, Infinity, 0));
  });

  it('interaction term: a·(free − (s*/gap)²) with s* = s0 + vT + v·dv/(2√(ab))', () => {
    const cases: [number, number, number][] = [
      [10, 20, 2], // approaching
      [10, 40, 0], // steady following
      [5, 15, -1], // leader slightly faster, but vT dominates: max(0, ·) inactive
      [12, 60, 4],
      [0, 10, 0], // standing: s* = s0, a(1 − (s0/gap)²) > 0
      [0, 1.5, 0], // standing closer than s0: negative
      [14, 35, -2],
    ];
    for (const [v, gap, dv] of cases) {
      const r = v / P.v0;
      const free = 1 - r * r * r * r;
      const inner = v * P.T + (v * dv) / (2 * Math.sqrt(P.a * P.b));
      expect(inner).toBeGreaterThanOrEqual(0); // these cases exercise the un-floored branch
      const sStar = P.s0 + inner;
      const expected = Math.min(P.a, Math.max(-9, P.a * (free - (sStar / gap) ** 2)));
      expect(Math.abs(idmAccel(P, v, gap, dv) - expected)).toBeLessThanOrEqual(tol(P, v, gap, dv));
    }
  });

  it('desired gap uses max(0, ·): a fast-receding leader leaves s* = s0', () => {
    // v = 10, dv = −10: vT + v·dv/(2√(ab)) = 15 − 100/(2√1.5) = 15 − 40.82 < 0 → s* = s0 = 2.
    const v = 10;
    const dv = -10;
    expect(v * P.T + (v * dv) / (2 * Math.sqrt(P.a * P.b))).toBeLessThan(0);
    for (const gap of [3, 10, 50]) {
      const r = v / P.v0;
      const expected = P.a * (1 - r * r * r * r - (P.s0 / gap) ** 2);
      expect(Math.abs(idmAccel(P, v, gap, dv) - expected)).toBeLessThanOrEqual(tol(P, v, gap, dv));
    }
    // Without the floor, s* would be 2 − 25.82 = −23.8 < 0 and (s*/gap)² would wrongly be large:
    // at gap = 3 the floored value is a(1 − 0.1975 − 0.444) = 0.358, unfloored would be ≈ −63.
    expect(idmAccel(P, v, 3, dv)).toBeGreaterThan(0);
  });

  it('clamps to −B_MAX for an emergency (tiny gap at speed)', () => {
    // v = 10, gap = 1, dv = 10: s* = 2 + 15 + 40.8 ≈ 57.8 → a(… − 3343) ≪ −9.
    expect(idmAccel(P, 10, 1, 10)).toBe(-9);
    expect(idmAccel(P, 20, 0.5, 0)).toBe(-9);
  });

  it('gap ≤ 0 returns −B_MAX regardless of speed', () => {
    for (const gap of [0, -0, -1e-12, -0.5, -100]) {
      for (const v of [0, 3, 20]) {
        expect(idmAccel(P, v, gap, 0)).toBe(-9);
        expect(idmAccel(P, v, gap, -5)).toBe(-9);
      }
    }
  });

  it('acceleration is zero at the equilibrium gap s_e(v) = (s0 + vT)/√(1 − (v/v0)^4) with dv = 0', () => {
    for (const p of [P, { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 }, { v0: 30, T: 1, s0: 2, a: 0.3, b: 3 }]) {
      for (let i = 1; i < 50; i++) {
        const v = (p.v0 * i) / 50; // up to 0.98·v0
        const r = v / p.v0;
        const r2 = r * r;
        const se = (p.s0 + v * p.T) / Math.sqrt(1 - r2 * r2);
        // free and (s*/s_e)² are equal in exact arithmetic. With s_e and free each carrying
        // ≤ ~4·EPS relative error (r, r², r⁴, 1 − r⁴; s0 + vT, √, ÷), (s*/s_e)² carries
        // ≤ 2·(4 + 4 + 1)·EPS ≈ 18·EPS relative, and both terms are ≤ 1, so
        // |acc| ≤ a·(4 + 18 + 2)·EPS < 32·a·EPS. Any model error would be ≥ 1e-6.
        expect(Math.abs(idmAccel(p, v, se, 0))).toBeLessThanOrEqual(32 * p.a * EPS);
      }
    }
  });

  it('property: matches the spec formula and stays within [−B_MAX, a]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: 1e-3, max: 500, noNaN: true }),
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.record({
          v0: fc.double({ min: 5, max: 40, noNaN: true }),
          T: fc.double({ min: 0.5, max: 3, noNaN: true }),
          s0: fc.double({ min: 0.5, max: 5, noNaN: true }),
          a: fc.double({ min: 0.2, max: 4, noNaN: true }),
          b: fc.double({ min: 0.5, max: 5, noNaN: true }),
        }),
        (v, gap, dv, p) => {
          const r = v / p.v0;
          const free = 1 - r * r * r * r;
          const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
          const expected = Math.min(p.a, Math.max(-9, p.a * (free - (sStar / gap) ** 2)));
          const got = idmAccel(p, v, gap, dv);
          expect(got).toBeGreaterThanOrEqual(-9);
          expect(got).toBeLessThanOrEqual(p.a);
          expect(Math.abs(got - expected)).toBeLessThanOrEqual(tol(p, v, gap, dv));
        },
      ),
      { seed: 20261114, numRuns: 2000 },
    );
  });
});
