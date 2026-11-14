/**
 * Clearance after strip rounding (docs/MODEL.md §1.5).
 *
 * Theory. For vehicles A (left) and B (right) with right_A = y_A + width_A/2 + c_A and
 * left_B = y_B − width_B/2 − c_B, the spans [floor(left/w), ceil(right/w) − 1] are disjoint
 *   ⇔ ceil(right_A/w) − 1 < floor(left_B/w) ⇔ ∃ integer k: right_A ≤ k·w ≤ left_B.
 * Hence the body gap g = (y_B − width_B/2) − (y_A + width_A/2) = (left_B − right_A) + c_A + c_B
 * of any allowed side-by-side pair satisfies g ≥ c_A + c_B, and for a given A the smallest
 * allowed g is c_A + c_B + (ceil(right_A/w)·w − right_A) ∈ [c_A + c_B, c_A + c_B + w).
 * (The statement assumes neither span is clamped at a road edge, which the generators ensure.)
 *
 * (1) checks this with the engine's occupiedStrips; (2) measures the gaps that actually occur
 * between longitudinally overlapping vehicles in congested strip-mode traffic, asserts
 * g ≥ c_A + c_B for every pair at every step, and prints the measured minimum per class pair:
 *   grep CLEARANCE_MEASURED
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { occupiedStrips, stripLayout } from '../../src/network/strips.ts';
import { classSet, corridorScenario, makeSim, type ClassSpec, type VView } from '../helpers/m2.ts';

describe('clearance theorem (static, engine strips)', () => {
  const arb = fc.record({
    W: fc.double({ min: 3, max: 14, noNaN: true }),
    target: fc.double({ min: 0.1, max: 1, noNaN: true }),
    wA: fc.double({ min: 0.5, max: 2.6, noNaN: true }),
    wB: fc.double({ min: 0.5, max: 2.6, noNaN: true }),
    cA: fc.double({ min: 0, max: 0.5, noNaN: true }),
    cB: fc.double({ min: 0, max: 0.5, noNaN: true }),
    uA: fc.double({ min: 0, max: 1, noNaN: true }),
    uB: fc.double({ min: 0, max: 1, noNaN: true }),
  });

  it('disjoint spans ⇔ a strip boundary in [right_A, left_B]; then body gap ≥ c_A + c_B', () => {
    fc.assert(
      fc.property(arb, (r) => {
        const L = stripLayout(r.W, r.target);
        const hA = r.wA / 2 + r.cA;
        const hB = r.wB / 2 + r.cB;
        fc.pre(2 * hA + 2 * hB <= r.W);
        // A in the left part, B to its right, both fully inside the road (no clamping)
        const yA = hA + r.uA * (r.W - 2 * hA - 2 * hB);
        const yB = yA + hA + hB + r.uB * (r.W - (yA + hA) - 2 * hB);
        const sA = occupiedStrips(yA, r.wA, r.cA, L);
        const sB = occupiedStrips(yB, r.wB, r.cB, L);
        const rightA = yA + r.wA / 2 + r.cA;
        const leftB = yB - r.wB / 2 - r.cB;
        const disjoint = sA[1] < sB[0];
        // boundary criterion, with a few-ulp guard against k·w landing exactly on an edge
        const k = Math.ceil(rightA / L.w);
        const boundaryInside = k * L.w <= leftB;
        const nearEdge = Math.abs(rightA / L.w - Math.round(rightA / L.w)) < 1e-9 || Math.abs(leftB / L.w - Math.round(leftB / L.w)) < 1e-9;
        if (!nearEdge) expect(disjoint).toBe(boundaryInside);
        if (disjoint) {
          const g = yB - r.wB / 2 - (yA + r.wA / 2);
          expect(g).toBeGreaterThanOrEqual(r.cA + r.cB - 1e-9);
        }
      }),
      { seed: 99, numRuns: 5000 },
    );
  });

  it('the minimal allowed gap is c_A + c_B + (ceil(right_A/w)·w − right_A) ∈ [c_A + c_B, c_A + c_B + w)', () => {
    fc.assert(
      fc.property(arb, (r) => {
        const L = stripLayout(r.W, r.target);
        const hA = r.wA / 2 + r.cA;
        const hB = r.wB / 2 + r.cB;
        fc.pre(2 * hA + 2 * hB + 2 * L.w <= r.W);
        const yA = hA + r.uA * (r.W - 2 * hA - 2 * hB - 2 * L.w);
        const rightA = yA + hA;
        const edge = Math.ceil(rightA / L.w) * L.w;
        // skip A within rounding distance of a strip boundary (either side): the engine may
        // evaluate right_A in a different operation order
        fc.pre(edge - rightA > 1e-9 * L.w && rightA - (edge - L.w) > 1e-9 * L.w);
        const gMin = r.cA + r.cB + (edge - rightA);
        expect(gMin).toBeGreaterThanOrEqual(r.cA + r.cB);
        expect(gMin).toBeLessThan(r.cA + r.cB + L.w);
        const eps = 1e-6 * L.w;
        const sA = occupiedStrips(yA, r.wA, r.cA, L);
        // B just right of the boundary: allowed; just left of it: overlapping
        const yIn = edge + eps + hB;
        const yOut = edge - eps + hB;
        expect(sA[1] < occupiedStrips(yIn, r.wB, r.cB, L)[0]).toBe(true);
        expect(sA[1] < occupiedStrips(yOut, r.wB, r.cB, L)[0]).toBe(false);
        // and at the allowed position the body gap is gMin (+eps)
        const g = yIn - r.wB / 2 - (yA + r.wA / 2);
        expect(Math.abs(g - (gMin + eps))).toBeLessThan(1e-9);
      }),
      { seed: 100, numRuns: 5000 },
    );
  });
});

/** console without DOM/node typings (the engine tsconfig has types: []) */
const log = (line: string) => (globalThis as unknown as { console: { log(s: string): void } }).console.log(line);

describe('clearance measured in congested strip-mode traffic', () => {
  const IDM = { v0: 14, T: 1.2, s0: 1.5, a: 1.5, b: 2 };
  const SPECS: ClassSpec[] = [
    { id: 'motorcycle', length: 2, width: 0.8, idm: { ...IDM, v0: 15, T: 0.9, s0: 1 }, c0: 0.15, c1: 0, maxLat: 1.0, politeness: 0.1, threshold: 0.05 },
    { id: 'auto', length: 3, width: 1.4, idm: { ...IDM, v0: 12 }, c0: 0.2, c1: 0, maxLat: 0.8, politeness: 0.2, threshold: 0.1 },
    { id: 'car', length: 4.5, width: 1.75, idm: IDM, c0: 0.25, c1: 0, maxLat: 0.6, politeness: 0.3, threshold: 0.1 },
  ];
  const c = new Map(SPECS.map((s) => [s.id, s.c0!]));

  it('every longitudinally overlapping pair keeps body gap ≥ c_A + c_B; prints the measured minimum', () => {
    const sim = makeSim(
      corridorScenario({
        lengthM: 600,
        widthM: 7,
        lanes: 2,
        change: { kind: 'laneDrop', atM: 400, dropLanes: 1, taperM: 50 }, // bottleneck → queue upstream
        rateVph: 3000,
        mode: 'strip',
        composition: { motorcycle: 0.5, auto: 0.2, car: 0.3 },
        seed: 2026,
      }),
      classSet(SPECS),
    );
    const minGap = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (let k = 0; k < 3000; k++) {
      sim.advance(1);
      const byLink = new Map<string, VView[]>();
      for (const v of sim.vehicles()) byLink.set(v.link, [...(byLink.get(v.link) ?? []), v]);
      for (const list of byLink.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            let A = list[i]!;
            let B = list[j]!;
            const overlap = Math.min(A.s, B.s) - Math.max(A.s - A.length, B.s - B.length);
            if (!(overlap > 1e-9)) continue;
            if (B.y < A.y) [A, B] = [B, A];
            const g = B.y - B.width / 2 - (A.y + A.width / 2);
            const cSum = c.get(A.classId)! + c.get(B.classId)!;
            expect(g).toBeGreaterThanOrEqual(cSum - 1e-9);
            const key = [A.classId, B.classId].sort().join('|');
            minGap.set(key, Math.min(minGap.get(key) ?? Infinity, g));
            pairs.set(key, (pairs.get(key) ?? 0) + 1);
          }
        }
      }
    }
    for (const [key, g] of [...minGap].sort()) {
      const [x, y] = key.split('|') as [string, string];
      const cSum = c.get(x as ClassSpec['id'])! + c.get(y as ClassSpec['id'])!;
      log(
        `CLEARANCE_MEASURED class=${key} min_gap=${g.toFixed(4)} c_sum=${cSum.toFixed(4)} excess=${(g - cSum).toFixed(4)} strip_w=${(7 / 23).toFixed(4)} pair_steps=${pairs.get(key)}`,
      );
    }
    // the scenario must actually produce side-by-side traffic (filtering)
    expect([...pairs.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  });
});
