/**
 * T14 — gap acceptance (docs/MODEL.md §3.3).
 *
 * Harders (1968). With Poisson major arrivals (rate q) every major gap is Exp(q). A gap of
 * length t admits n(t) = 1{t ≥ tc}·(1 + ⌊(t − tc)/tf⌋) minor entries in this discharge model
 * (entries start at the major instant because the previous entry happened ≥ tc ≥ tf earlier).
 * P(n ≥ k) = p·r^{k−1} with p = e^{−q tc}, r = e^{−q tf}, so E[n] = p/(1 − r) and the entry rate
 * is q·E[n] = q e^{−q tc}/(1 − e^{−q tf}). E[n²] = Σ(2k − 1)P(n ≥ k) = p(1 + r)/(1 − r)².
 * The entry count over a horizon H is compound Poisson (≈ qH gaps, i.i.d. counts), so
 * Var(N) = qH·E[n²] and |N/H − capacity| ≤ 5·√(q E[n²]/H) + 2/H (edge gaps) at 5σ.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { acceptGap, saturatedDischarge } from '../../src/junction/gap.ts';
import { dischargeRef, harders } from '../helpers/m3.ts';
import { testPrng } from '../helpers/numeric.ts';

describe('acceptGap', () => {
  it('truth table: timeToNext ≥ tc AND sinceLastEntry ≥ tf (boundaries inclusive)', () => {
    const cases: [number, number, number, number, boolean][] = [
      [4, 2, 4, 2, true],
      [3.999, 2, 4, 2, false],
      [4, 1.999, 4, 2, false],
      [3, 1, 4, 2, false],
      [Infinity, Infinity, 4, 2, true],
      [Infinity, 0, 4, 2, false],
      [10, Infinity, 4, 2, true],
      [0, 0, 0, 0, true],
    ];
    for (const [ttn, since, tc, tf, ok] of cases) expect(acceptGap(ttn, since, tc, tf)).toBe(ok);
  });
});

describe('saturatedDischarge', () => {
  it('hand-derived cases', () => {
    // no majors: every tf from 0
    expect(saturatedDischarge([], 4, 2, 9)).toEqual([0, 2, 4, 6, 8]);
    // major at 5: 0 (gap 5 ≥ 4); at 2 the gap is 3 < 4 → wait for the major → 5, 7, 9
    expect(saturatedDischarge([5], 4, 2, 10.5)).toEqual([0, 5, 7, 9]);
    // majors 3, 3.5, 12: first acceptable instant is 3.5 (after the platoon; next major 12),
    // then 6 (12 − 6 = 6 ≥ 4); 8.5 would leave 3.5 < 4 → wait for 12 → 12, 14.5, 17, 19.5
    expect(saturatedDischarge([3, 3.5, 12], 4, 2.5, 20)).toEqual([3.5, 6, 12, 14.5, 17, 19.5]);
    // gap exactly tc is accepted (≥): 6 has 10 − 6 = 4
    expect(saturatedDischarge([10], 4, 2, 9)).toEqual([0, 2, 4, 6]);
  });

  it('property: matches the reference on random major streams (|Δ| ≤ 1e-9)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), fc.double({ min: 2, max: 7, noNaN: true }), fc.double({ min: 0.3, max: 1, noNaN: true }), (seed, tc, frac) => {
        const tf = Math.max(1, tc * frac);
        const g = testPrng(seed);
        const majors: number[] = [];
        let t = 0;
        for (;;) {
          t += -Math.log(1 - g()) * 6;
          if (t > 300) break;
          majors.push(t);
        }
        const got = saturatedDischarge(majors, tc, tf, 300);
        const ref = dischargeRef(majors, tc, tf, 300);
        expect(got.length).toBe(ref.length);
        got.forEach((x, i) => expect(Math.abs(x - ref[i]!)).toBeLessThanOrEqual(1e-9));
      }),
      { seed: 14, numRuns: 300 },
    );
  });

  it('long-run entry rate with Poisson majors equals Harders\' capacity (5σ compound-Poisson bound)', () => {
    const tc = 4.5;
    const tf = 2.5;
    const H = 100_000;
    for (const q of [0.05, 0.1, 0.2, 0.3]) {
      const g = testPrng(Math.round(q * 1000) + 7);
      const majors: number[] = [];
      let t = 0;
      for (;;) {
        t += -Math.log(1 - g()) / q;
        if (t > H) break;
        majors.push(t);
      }
      const n = saturatedDischarge(majors, tc, tf, H).length;
      const h = harders(q, tc, tf);
      const tol = 5 * Math.sqrt((q * h.En2) / H) + 2 / H;
      expect(Math.abs(n / H - h.capacity), `q = ${q}`).toBeLessThanOrEqual(tol);
    }
  });
});
