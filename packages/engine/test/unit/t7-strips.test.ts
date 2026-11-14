/**
 * T7 — lateral strips (docs/MODEL.md §1.5, layout revised in M2). Expected values are worked
 * out by hand from the spec formulas:
 *   strip mode: fixed width Δ, grid anchored at the left edge shifted by o ∈ [0, Δ);
 *     boundaries {o + kΔ : 0 < o + kΔ < W} ∪ {0, W}; n = (o > 0 ? 1 : 0) + ceil((W − o)/Δ − 1e-9);
 *     stripIndex(x) = clamp(floor((x − o)/Δ + 1e-9) + (o > 0 ? 1 : 0), 0, n − 1);
 *     occupancy [left, right) = [y − width/2 − c, y + width/2 + c): lo = stripIndex(left),
 *     hi = clamp(ceil((right − o)/Δ − 1e-9) − 1 + (o > 0 ? 1 : 0), 0, n − 1);
 *   lane mode: laneLayout(W, lanes) = { n: lanes, w: W/lanes, o: 0 }, laneStrip = [k, k] with
 *     k = clamp(floor(y/w), 0, n − 1).
 * Where cases use dyadic widths (0.25, 0.5 m) every quantity is exact in binary floating point,
 * so boundaries are tested exactly (half-open intervals).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { laneLayout, laneStrip, occupiedStrips, stripIndex, stripLayout, sweptStrips } from '../../src/network/strips.ts';
import { boundariesRef, layoutRef, occupiedRef, stripIndexRef } from '../helpers/strips-ref.ts';

describe('T7 stripLayout', () => {
  it('fixed Δ, o = 0: n = ceil(W/Δ − 1e-9), last strip possibly narrower', () => {
    expect(stripLayout(3.5, 0.25)).toEqual({ n: 14, w: 0.25, o: 0 }); // 14 full strips
    expect(stripLayout(7, 0.25)).toEqual({ n: 28, w: 0.25, o: 0 });
    // 7/0.3 = 23.33 → 24 strips: 23 of 0.3 m and a last one [6.9, 7) of 0.1 m
    expect(stripLayout(7, 0.3)).toEqual({ n: 24, w: 0.3, o: 0 });
    // 7.2/0.3 = 24.000000000000004 in floating point: the 1e-9 tolerance gives exactly 24
    expect(stripLayout(7.2, 0.3).n).toBe(24);
    expect(stripLayout(3, 0.5)).toEqual({ n: 6, w: 0.5, o: 0 });
    // narrower than one strip: n = 1, and the strip is the whole road
    expect(stripLayout(1, 3)).toEqual({ n: 1, w: 3, o: 0 });
    expect(stripLayout(7, 0.3, 0)).toEqual(stripLayout(7, 0.3));
  });

  it('offset o > 0: a first strip [0, o), then Δ-strips from o', () => {
    // W = 3, Δ = 0.5, o = 0.25: boundaries 0, .25, .75, 1.25, 1.75, 2.25, 2.75, 3 → 7 strips,
    // n = 1 + ceil(2.75/0.5 − 1e-9) = 1 + 6 = 7
    expect(stripLayout(3, 0.5, 0.25)).toEqual({ n: 7, w: 0.5, o: 0.25 });
    // W = 3, Δ = 0.5, o = 0.375: boundaries 0, .375, .875, …, 2.875, 3 → 1 + ceil(5.25) = 7
    expect(stripLayout(3, 0.5, 0.375)).toEqual({ n: 7, w: 0.5, o: 0.375 });
    // W = 1.25, Δ = 0.5, o = 0.25: boundaries 0, .25, .75, 1.25 → 1 + ceil(2 − 1e-9) = 3
    expect(stripLayout(1.25, 0.5, 0.25).n).toBe(3);
  });

  it('property: matches the formula, boundaries tile [0, W] with interior strips of width Δ', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2, max: 25, noNaN: true }),
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (W, k, of) => {
          const d = k / 10;
          const o = of * d;
          fc.pre(o === 0 || (o > 1e-6 && d - o > 1e-6));
          const L = stripLayout(W, d, o);
          expect(L).toEqual(layoutRef(W, d, o));
          const b = boundariesRef(W, L);
          expect(b.length).toBe(L.n + 1);
          for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThan(b[i - 1]! - 1e-12);
          // interior strips have width Δ; the last one is in (0, Δ] up to the 1e-9 tolerance
          for (let i = (o > 0 ? 2 : 1); i < L.n; i++) expect(Math.abs(b[i]! - b[i - 1]! - d)).toBeLessThan(1e-9);
          const last = W - b[L.n - 1]!;
          expect(last).toBeGreaterThan(-1e-9 * d);
          expect(last).toBeLessThanOrEqual(d * (1 + 1e-9));
        },
      ),
      { seed: 7, numRuns: 2000 },
    );
  });

  it('lane mode: laneLayout(W, lanes) = { n: lanes, w: W/lanes, o: 0 }', () => {
    for (const W of [3.5, 6, 7, 7.3, 10.5, 12.25]) {
      for (let lanes = 1; lanes <= 6; lanes++) expect(laneLayout(W, lanes)).toEqual({ n: lanes, w: W / lanes, o: 0 });
    }
  });
});

describe('T7 stripIndex', () => {
  it('o = 0: floor(x/Δ + 1e-9), boundaries belong to the strip on their right, clamped', () => {
    const L = stripLayout(3, 0.5); // n = 6
    expect([0, 0.25, 0.5, 0.75, 1, 2.999, 3, 3.5, -0.1].map((x) => stripIndex(x, L))).toEqual([0, 0, 1, 1, 2, 5, 5, 5, 0]);
    // a value a few ulps below a boundary still counts as on it (tolerance 1e-9 strips)
    const L3 = stripLayout(7, 0.3);
    expect(stripIndex(0.7 - 0.1, L3)).toBe(2); // 0.6 / 0.3 = 1.9999999999999998 → 2
    expect(stripIndex(6.95, L3)).toBe(23); // the last, partial strip [6.9, 7)
  });

  it('o > 0: the first strip is [0, o)', () => {
    const L = stripLayout(3, 0.5, 0.25); // strips [0,.25) [.25,.75) [.75,1.25) … [2.75,3)
    expect([0, 0.2, 0.25, 0.5, 0.75, 1.24, 1.25, 2.8, 3].map((x) => stripIndex(x, L))).toEqual([0, 0, 1, 1, 2, 2, 3, 6, 6]);
  });

  it('property: matches the reference', () => {
    fc.assert(
      fc.property(fc.double({ min: 2, max: 25, noNaN: true }), fc.integer({ min: 1, max: 10 }), fc.double({ min: 0, max: 0.9, noNaN: true }), fc.double({ min: -1, max: 26, noNaN: true }), (W, k, of, x) => {
        const L = stripLayout(W, k / 10, (of * k) / 10);
        expect(stripIndex(x, L)).toBe(stripIndexRef(x, L));
      }),
      { seed: 8, numRuns: 2000 },
    );
  });
});

describe('T7 occupiedStrips (strip mode)', () => {
  const L6 = stripLayout(3, 0.5); // { n: 6, w: 0.5, o: 0 }: exact edges at 0, 0.5, …, 3

  it('half-open occupancy [y − width/2 − c, y + width/2 + c): lo = stripIndex(left), hi via ceil − 1', () => {
    // [0.5, 1.5) → strips 1, 2 (an edge exactly on 1.5 does NOT occupy strip 3)
    expect(occupiedStrips(1, 1, 0, L6)).toEqual([1, 2]);
    // [0.25, 1.25) → 0..2
    expect(occupiedStrips(0.75, 1, 0, L6)).toEqual([0, 2]);
    // [1.0, 1.5) → strip 2 only
    expect(occupiedStrips(1.25, 0.5, 0, L6)).toEqual([2, 2]);
    // [0.9, 1.6) → floor(1.8) = 1, ceil(3.2) − 1 = 3 (non-dyadic but far from edges)
    expect(occupiedStrips(1.25, 0.7, 0, L6)).toEqual([1, 3]);
  });

  it('clearance widens both sides', () => {
    expect(occupiedStrips(1, 1, 0.25, L6)).toEqual([0, 3]); // [0.25, 1.75)
    expect(occupiedStrips(1, 1, 0.5, L6)).toEqual([0, 3]); // [0, 2): 2.0 excluded from strip 4
  });

  it('clamps to [0, n − 1] at the road edges', () => {
    expect(occupiedStrips(0.25, 1, 0, L6)).toEqual([0, 1]); // [−0.25, 0.75)
    expect(occupiedStrips(2.75, 1, 0, L6)).toEqual([4, 5]); // [2.25, 3.25)
    expect(occupiedStrips(1.5, 5, 0, L6)).toEqual([0, 5]);
    expect(occupiedStrips(-3, 1, 0, L6)).toEqual([0, 0]);
    expect(occupiedStrips(10, 1, 0, L6)).toEqual([5, 5]);
  });

  it('with o > 0 (W = 3, Δ = 0.5, o = 0.25)', () => {
    const L = stripLayout(3, 0.5, 0.25);
    // [0.5, 1.5): strips 1 [.25,.75), 2 [.75,1.25), 3 [1.25,1.75)
    expect(occupiedStrips(1, 1, 0, L)).toEqual([1, 3]);
    // [0.75, 1.25) exactly one strip, edges on boundaries
    expect(occupiedStrips(1, 0.5, 0, L)).toEqual([2, 2]);
    // [0, 0.25): the first, narrow strip
    expect(occupiedStrips(0.125, 0.25, 0, L)).toEqual([0, 0]);
    // [2.75, 3): the last strip
    expect(occupiedStrips(2.875, 0.25, 0, L)).toEqual([6, 6]);
  });

  it('a body in the last, partial strip (W = 7, Δ = 0.3: [6.9, 7) is strip 23)', () => {
    const L = stripLayout(7, 0.3);
    expect(occupiedStrips(6.95, 0.1, 0, L)).toEqual([23, 23]);
    // car against the right edge: [7 − 2.2, 7) = [4.8, 7) → 16..23
    expect(occupiedStrips(5.9, 1.8, 0.2, L)).toEqual([16, 23]);
  });

  it('default 0.25 m strips on a 3.5 m road and 0.3 m strips (W = 3.5)', () => {
    const Q = stripLayout(3.5, 0.25); // n = 14
    // car at lane centre: [0.7, 2.8) → floor(2.8) = 2, ceil(11.2) − 1 = 11
    expect(occupiedStrips(1.75, 1.7, 0.2, Q)).toEqual([2, 11]);
    const L = stripLayout(3.5, 0.3); // n = 12, last strip [3.3, 3.5)
    expect(occupiedStrips(1.75, 1.7, 0.2, L)).toEqual([2, 9]); // [0.7, 2.8): floor(2.33), ceil(9.33) − 1
    expect(occupiedStrips(0.6, 0.8, 0.15, L)).toEqual([0, 3]); // [0.05, 1.15)
    expect(occupiedStrips(1.75, 2.9, 0.3, L)).toEqual([0, 11]); // the whole road
  });

  it('property: matches the reference; [lo, hi] are exactly the strips meeting [left, right)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2, max: 25, noNaN: true }),
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 0.9, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0.2, max: 3, noNaN: true }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        (W, k, of, u, width, c) => {
          const d = k / 10;
          const L = stripLayout(W, d, of * d);
          const h = width / 2 + c;
          fc.pre(2 * h <= W);
          const y = h + u * (W - 2 * h);
          const got = occupiedStrips(y, width, c, L);
          expect(got).toEqual(occupiedRef(y, width, c, L));
          // geometric meaning (edges more than 1e-6 m from a boundary)
          const b = boundariesRef(W, L);
          const left = y - width / 2 - c;
          const right = y + width / 2 + c;
          fc.pre(b.every((x) => Math.abs(x - left) > 1e-6 && Math.abs(x - right) > 1e-6));
          expect(b[got[0]]!).toBeLessThanOrEqual(left);
          expect(left).toBeLessThan(b[got[0] + 1]!);
          expect(b[got[1]]!).toBeLessThan(right);
          expect(right).toBeLessThanOrEqual(b[got[1] + 1]!);
        },
      ),
      { seed: 9, numRuns: 3000 },
    );
  });
});

describe('T7 grid alignment across segments', () => {
  it('two kerb-aligned layouts of different widths share every boundary below the smaller width', () => {
    fc.assert(
      fc.property(fc.double({ min: 2, max: 20, noNaN: true }), fc.double({ min: 0.01, max: 5, noNaN: true }), fc.integer({ min: 1, max: 10 }), fc.double({ min: 0, max: 1, noNaN: true }), (W1, dW, k, u) => {
        const d = k / 10;
        const A = stripLayout(W1, d);
        const B = stripLayout(W1 + dW, d);
        const x = u * W1;
        fc.pre(x < W1);
        // away from the 1e-9-strip tolerance band around a grid line (which may lie beyond W1)
        fc.pre(Math.abs(x / d - Math.round(x / d)) > 1e-6);
        expect(stripIndex(x, A)).toBe(stripIndex(x, B));
        const bA = boundariesRef(W1, A).slice(0, -1); // interior boundaries of A (W1 itself excepted)
        const bB = new Set(boundariesRef(W1 + dW, B).map((v) => v.toFixed(9)));
        for (const v of bA) expect(bB.has(v.toFixed(9))).toBe(true);
      }),
      { seed: 10, numRuns: 1000 },
    );
  });

  it('a movement layout with o = (−b0) mod Δ continues its link grid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 10 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (b20, k, u1, u2) => {
        const d = k / 10;
        const b0 = b20 / 20; // band start 0, 0.05, …, 3 m
        const bandW = 3.5;
        const link = stripLayout(b0 + bandW + 1, d);
        const o = (((-b0 % d) + d) % d);
        const mov = stripLayout(bandW, d, o);
        // two points inside the band: equal strip-index differences on the link and the movement
        const x1 = b0 + u1 * bandW * 0.999;
        const x2 = b0 + u2 * bandW * 0.999;
        expect(stripIndex(x2, link) - stripIndex(x1, link)).toBe(stripIndex(x2 - b0, mov) - stripIndex(x1 - b0, mov));
      }),
      { seed: 11, numRuns: 2000 },
    );
  });

  it('a pair side by side with disjoint spans on 7.2 m stays disjoint on a kerb-aligned 7.0 m link', () => {
    // The property that failed with the pre-M2 per-segment tiling w = W/round(W/Δ).
    const A72 = stripLayout(7.2, 0.3);
    const A70 = stripLayout(7.0, 0.3);
    fc.assert(
      fc.property(
        fc.double({ min: 0.6, max: 2.6, noNaN: true }),
        fc.double({ min: 0.6, max: 2.6, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (wA, wB, cA, cB, uA, uB) => {
          const hA = wA / 2 + cA;
          const hB = wB / 2 + cB;
          fc.pre(2 * hA + 2 * hB <= 7.0);
          const yA = hA + uA * (7.0 - 2 * hA - 2 * hB);
          const yB = yA + hA + hB + uB * (7.0 - (yA + hA) - 2 * hB); // both inside [0, 7.0]
          const up = [occupiedStrips(yA, wA, cA, A72), occupiedStrips(yB, wB, cB, A72)];
          fc.pre(up[0]![1] < up[1]![0]); // disjoint upstream
          const down = [occupiedStrips(yA, wA, cA, A70), occupiedStrips(yB, wB, cB, A70)];
          expect(down[0]![1]).toBeLessThan(down[1]![0]);
        },
      ),
      { seed: 12, numRuns: 5000 },
    );
    // And the old tiling really failed it: a concrete pair, computed with the old formula.
    const oldTiling = (W: number, y: number, h: number) => {
      const n = Math.round(W / 0.3);
      const w = W / n;
      return [Math.max(0, Math.floor((y - h) / w)), Math.min(n - 1, Math.ceil((y + h) / w) - 1)];
    };
    // motorcycle [2.35, 3.55) next to a car [3.65, 6.05) (0.1 m apart): under w = 7.2/24 = 0.3
    // they occupy 7..11 and 12..20 (3.55/0.3 = 11.83, 3.65/0.3 = 12.17); under w = 7/23 = 0.30435
    // the car starts in strip 11 (3.65/w = 11.99) and they share it.
    const m72 = oldTiling(7.2, 2.95, 0.6);
    const c72 = oldTiling(7.2, 4.85, 1.2);
    const m70 = oldTiling(7.0, 2.95, 0.6);
    const c70 = oldTiling(7.0, 4.85, 1.2);
    expect(m72[1]! < c72[0]!).toBe(true);
    expect(m70[1]! < c70[0]!).toBe(false);
    // with the fixed kerb-aligned grid the same pair stays disjoint on 7.0 m: 11 < 12
    expect(occupiedStrips(2.95, 1.0, 0.1, A70)[1]).toBeLessThan(occupiedStrips(4.85, 2.0, 0.2, A70)[0]);
  });
});

describe('T7 sweptStrips', () => {
  const L6 = stripLayout(3, 0.5);
  it('span of both end positions: [min(lo_A, lo_B), max(hi_A, hi_B)]', () => {
    expect(sweptStrips(0.75, 2.25, 1, 0, L6)).toEqual([0, 5]);
    expect(sweptStrips(2.25, 0.75, 1, 0, L6)).toEqual([0, 5]);
    expect(sweptStrips(1, 1.5, 1, 0, L6)).toEqual([1, 3]);
    expect(sweptStrips(1, 1, 1, 0.25, L6)).toEqual(occupiedStrips(1, 1, 0.25, L6));
    expect(sweptStrips(1, 2.5, 1, 0.25, L6)).toEqual([0, 5]);
  });
});

describe('T7 laneStrip (lane mode)', () => {
  it('k = clamp(floor(y/w), 0, n − 1), returned as [k, k], regardless of width', () => {
    const L = laneLayout(7, 2);
    expect(laneStrip(1.75, L)).toEqual([0, 0]);
    expect(laneStrip(3.4999, L)).toEqual([0, 0]);
    expect(laneStrip(3.5, L)).toEqual([1, 1]);
    expect(laneStrip(5.25, L)).toEqual([1, 1]);
    expect(laneStrip(-0.2, L)).toEqual([0, 0]);
    expect(laneStrip(7, L)).toEqual([1, 1]);
    expect(laneStrip(9, L)).toEqual([1, 1]);
    const L3 = laneLayout(10.5, 3);
    expect(laneStrip(8.75, L3)).toEqual([2, 2]);
    expect(laneStrip(5.25, L3)).toEqual([1, 1]);
  });
});
