/**
 * T7 — lateral strips (docs/MODEL.md §1.5). Expected values are worked out by hand from the
 * spec formulas; where a case uses dyadic widths (0.25, 0.5 m) every quantity is exact in
 * binary floating point, so strip boundaries are tested exactly (half-open intervals).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { laneStrip, occupiedStrips, stripLayout, sweptStrips } from '../../src/network/strips.ts';
import { layoutRef, occupiedRef } from '../helpers/strips-ref.ts';

describe('T7 stripLayout', () => {
  it('n = max(1, round(W/Δ)), w = W/n', () => {
    // 3.5 / 0.3 = 11.67 → n = 12, w = 0.291666…
    const a = stripLayout(3.5, 0.3);
    expect(a.n).toBe(12);
    expect(a.w).toBe(3.5 / 12);
    // 7 / 0.3 = 23.33 → 23
    expect(stripLayout(7, 0.3).n).toBe(23);
    // 10.5 / 0.3 = 35 (35.000000000000004 in floating point) → 35
    expect(stripLayout(10.5, 0.3).n).toBe(35);
    // 3 / 0.5 = 6 exactly; w = 0.5 exactly
    expect(stripLayout(3, 0.5)).toEqual({ n: 6, w: 0.5 });
    // narrower than one target strip: n = max(1, round(0.33)) = 1, w = W
    expect(stripLayout(1, 3)).toEqual({ n: 1, w: 1 });
    // (Exact .5 ratios are deliberately not tested: MODEL.md does not say how round() breaks
    // ties, and JS Math.round (half up) differs from Python round (half even).)
  });

  it('strips tile the road exactly: n·w = W (up to one rounding of W/n)', () => {
    for (const W of [2, 3.5, 5.5, 7, 7.3, 10.5, 14, 21, 25]) {
      for (const d of [0.1, 0.25, 0.3, 0.45, 1]) {
        const { n, w } = stripLayout(W, d);
        expect(Number.isInteger(n) && n >= 1).toBe(true);
        expect(w).toBe(W / n);
        expect(Math.abs(n * w - W)).toBeLessThanOrEqual(n * Number.EPSILON * W);
      }
    }
  });

  it('lane mode: target W/lanes gives n = lanes, one strip per lane', () => {
    for (const W of [3.5, 6, 7, 7.3, 10.5, 12.25]) {
      for (let lanes = 1; lanes <= 6; lanes++) {
        const L = stripLayout(W, W / lanes);
        expect(L.n).toBe(lanes);
        expect(L.w).toBe(W / lanes);
      }
    }
  });
});

describe('T7 occupiedStrips (strip mode)', () => {
  const L6 = { n: 6, w: 0.5 }; // 3 m road, exact strip edges at 0, 0.5, …, 3

  it('half-open occupancy [y − width/2 − c, y + width/2 + c): lo = floor, hi = ceil − 1', () => {
    // [0.5, 1.5) → strips 1, 2 (an edge exactly on 1.5 does NOT occupy strip 3)
    expect(occupiedStrips(1, 1, 0, L6)).toEqual([1, 2]);
    // [0.25, 1.25) → floor(0.5) = 0, ceil(2.5) − 1 = 2
    expect(occupiedStrips(0.75, 1, 0, L6)).toEqual([0, 2]);
    // [1.0, 1.5) → strip 2 only
    expect(occupiedStrips(1.25, 0.5, 0, L6)).toEqual([2, 2]);
    // [0.9, 1.6)·: floor(1.8) = 1, ceil(3.2) − 1 = 3  (non-dyadic but far from edges)
    expect(occupiedStrips(1.25, 0.7, 0, L6)).toEqual([1, 3]);
  });

  it('clearance widens both sides: c(v) adds to each side', () => {
    // body [0.5, 1.5) → with c = 0.25: [0.25, 1.75) → strips 0..3
    expect(occupiedStrips(1, 1, 0.25, L6)).toEqual([0, 3]);
    // c = 0.5: [0, 2) → 0..3 (right edge exactly 2.0 excluded from strip 4)
    expect(occupiedStrips(1, 1, 0.5, L6)).toEqual([0, 3]);
  });

  it('clamps to [0, n − 1] at the road edges', () => {
    // [−0.25, 0.75) → floor(−0.5) = −1 → 0; hi = ceil(1.5) − 1 = 1
    expect(occupiedStrips(0.25, 1, 0, L6)).toEqual([0, 1]);
    // [2.25, 3.25) → lo = 4; ceil(6.5) − 1 = 6 → 5
    expect(occupiedStrips(2.75, 1, 0, L6)).toEqual([4, 5]);
    // wider than the road: everything
    expect(occupiedStrips(1.5, 5, 0, L6)).toEqual([0, 5]);
    // entirely off the left edge (pathological): both ends clamp to 0
    expect(occupiedStrips(-3, 1, 0, L6)).toEqual([0, 0]);
    // entirely off the right edge: both clamp to 5
    expect(occupiedStrips(10, 1, 0, L6)).toEqual([5, 5]);
  });

  it('default 0.3 m strips on a 3.5 m road (w = 3.5/12)', () => {
    const L = stripLayout(3.5, 0.3);
    // Car at lane centre: [1.75 − 0.85 − 0.2, 1.75 + 0.85 + 0.2) = [0.7, 2.8)
    //   lo = floor(0.7/0.29167) = floor(2.4) = 2; hi = ceil(9.6) − 1 = 9
    expect(occupiedStrips(1.75, 1.7, 0.2, L)).toEqual([2, 9]);
    // Motorcycle near the left edge: [0.6 − 0.4 − 0.15, 0.6 + 0.4 + 0.15) = [0.05, 1.15)
    //   lo = floor(0.171) = 0; hi = ceil(3.943) − 1 = 3
    expect(occupiedStrips(0.6, 0.8, 0.15, L)).toEqual([0, 3]);
    // 2.9 m body + 0.3 m clearance each side fills the road exactly: [0, 3.5) → [0, 11]
    expect(occupiedStrips(1.75, 2.9, 0.3, L)).toEqual([0, 11]);
  });

  it('property: matches the spec formula on exactly representable (dyadic) inputs', () => {
    // All inputs are multiples of 1/64 and w ∈ {1/4, 1/2}, so every intermediate value is
    // exact and any operation order gives the same floor/ceil; no tolerance is needed.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom(0.25, 0.5),
        fc.integer({ min: -64, max: 64 * 12 }),
        fc.integer({ min: 1, max: 64 * 4 }),
        fc.integer({ min: 0, max: 64 }),
        (n, w, y64, w64, c64) => {
          const L = { n, w };
          const got = occupiedStrips(y64 / 64, w64 / 64, c64 / 64, L);
          expect(got).toEqual(occupiedRef(y64 / 64, w64 / 64, c64 / 64, L));
          expect(got[0]).toBeLessThanOrEqual(got[1]);
          expect(got[0]).toBeGreaterThanOrEqual(0);
          expect(got[1]).toBeLessThanOrEqual(n - 1);
        },
      ),
      { seed: 7, numRuns: 3000 },
    );
  });

  it('property: layout matches the spec formula', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 25 }), fc.integer({ min: 1, max: 10 }), (W, k) => {
        const d = k / 10;
        const q = W / d;
        fc.pre(Math.abs(q - Math.floor(q) - 0.5) > 1e-9); // skip round() ties (unspecified)
        expect(stripLayout(W, d)).toEqual(layoutRef(W, d));
      }),
      { seed: 8 },
    );
  });
});

describe('T7 sweptStrips', () => {
  const L6 = { n: 6, w: 0.5 };
  it('span of both end positions: [min(lo_A, lo_B), max(hi_A, hi_B)]', () => {
    // A: y = 0.75, width 1 → [0, 2];  B: y = 2.25 → [1.75, 2.75) → [3, 5]
    expect(sweptStrips(0.75, 2.25, 1, 0, L6)).toEqual([0, 5]);
    // order of A and B does not matter
    expect(sweptStrips(2.25, 0.75, 1, 0, L6)).toEqual([0, 5]);
    // overlapping ends: A [0.5,1.5) → [1,2], B [1,2) → [2,3]
    expect(sweptStrips(1, 1.5, 1, 0, L6)).toEqual([1, 3]);
    // no manoeuvre: equals occupiedStrips
    expect(sweptStrips(1, 1, 1, 0.25, L6)).toEqual(occupiedStrips(1, 1, 0.25, L6));
    // clearance included at both ends: A [0.25,1.75) → [0,3], B (y=2.5) [1.75,3.25) → [3,5]
    expect(sweptStrips(1, 2.5, 1, 0.25, L6)).toEqual([0, 5]);
  });
});

describe('T7 laneStrip (lane mode)', () => {
  it('k = clamp(floor(y/w), 0, n − 1), returned as [k, k], regardless of width', () => {
    const L = stripLayout(7, 3.5); // 2 lanes of 3.5 m
    expect(L).toEqual({ n: 2, w: 3.5 });
    expect(laneStrip(1.75, L)).toEqual([0, 0]);
    expect(laneStrip(3.4999, L)).toEqual([0, 0]);
    expect(laneStrip(3.5, L)).toEqual([1, 1]); // boundary belongs to the lane on its right
    expect(laneStrip(5.25, L)).toEqual([1, 1]);
    expect(laneStrip(-0.2, L)).toEqual([0, 0]); // clamped
    expect(laneStrip(7, L)).toEqual([1, 1]); // floor(2) = 2 → clamped to n − 1
    expect(laneStrip(9, L)).toEqual([1, 1]);
    const L3 = stripLayout(10.5, 3.5);
    expect(L3.n).toBe(3);
    expect(laneStrip(8.75, L3)).toEqual([2, 2]);
    expect(laneStrip(5.25, L3)).toEqual([1, 1]);
  });
});
