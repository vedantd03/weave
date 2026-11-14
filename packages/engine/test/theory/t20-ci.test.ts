/**
 * T20 — confidence intervals (docs/MODEL.md §5.1).
 *
 * Coverage: for i.i.d. normal samples the t interval x̄ ± t_{0.975, n−1}·s/√n covers the true
 * mean with probability exactly 0.95 (Student 1908). With R independent replications the
 * empirical coverage is Binomial(R, 0.95)/R, sd = √(0.95·0.05/R); we accept ±5 sd. Samples come
 * from the engine's seeded Rng (not under test here) through Box–Muller written in the test.
 */
import { describe, expect, it } from 'vitest';
import { meanCI, pairedCI } from '../../src/stats/ci.ts';
import { Rng } from '../../src/core/rng.ts';
import { boxMuller, meanCIRef, tQuantileRef } from '../helpers/stats-ref.ts';

const R = 20_000;
const MU = 3.7;
const SIGMA = 2.5;

function normals(rng: Rng, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const [a, b] = boxMuller(rng.next(), rng.next());
    out.push(MU + SIGMA * a, MU + SIGMA * b);
  }
  return out.slice(0, n);
}

describe('T20 meanCI', () => {
  it('formula: half = t_{(1+level)/2, n−1}·sd/√n with the sample sd; n < 2 → Infinity', () => {
    const xs = [1.5, 2.25, 4, 0.5, 3.75, 2];
    const r = meanCIRef(xs);
    const got = meanCI(xs);
    expect(got.n).toBe(6);
    expect(Math.abs(got.mean - r.mean)).toBeLessThan(1e-12);
    expect(Math.abs(got.sd - r.sd)).toBeLessThan(1e-12);
    // tQuantile is accurate to 1e-6·max(1, t) (§5.1), so half is within that relative error
    expect(Math.abs(got.half - r.half)).toBeLessThanOrEqual(1e-6 * r.half + 1e-12);
    expect(Math.abs(got.lo - (got.mean - got.half))).toBeLessThan(1e-12);
    expect(Math.abs(got.hi - (got.mean + got.half))).toBeLessThan(1e-12);
    const g90 = meanCI(xs, 0.9);
    expect(Math.abs(g90.half - (tQuantileRef(0.95, 5) * r.sd) / Math.sqrt(6))).toBeLessThanOrEqual(1e-6 * g90.half + 1e-12);
    expect(meanCI([4.2]).half).toBe(Infinity);
    expect(meanCI([4.2]).mean).toBe(4.2);
  });

  for (const n of [5, 10, 30]) {
    it(`coverage of the 95% interval for n = ${n} is 0.95 within 5 binomial sd (R = ${R})`, () => {
      const rng = new Rng(2000 + n);
      let covered = 0;
      for (let r = 0; r < R; r++) {
        const ci = meanCI(normals(rng, n));
        if (ci.lo <= MU && MU <= ci.hi) covered++;
      }
      const sd = Math.sqrt((0.95 * 0.05) / R);
      expect(Math.abs(covered / R - 0.95)).toBeLessThanOrEqual(5 * sd);
    });
  }
});

describe('T20 pairedCI', () => {
  it('is meanCI of the differences b − a', () => {
    const rng = new Rng(77);
    const a = normals(rng, 12);
    const b = a.map((x) => x + 0.4 + 0.3 * normals(rng, 1)[0]!);
    expect(pairedCI(a, b)).toEqual(meanCI(b.map((x, i) => x - a[i]!)));
    expect(pairedCI(a, b, 0.9)).toEqual(meanCI(b.map((x, i) => x - a[i]!), 0.9));
  });

  it('identical inputs give exactly [0, 0]', () => {
    const a = [3.1, 2.7, 5.5, 4.25];
    const c = pairedCI(a, [...a]);
    expect([c.mean, c.half, c.lo, c.hi, c.sd]).toEqual([0, 0, 0, 0, 0]);
    expect(c.n).toBe(4);
  });
});
