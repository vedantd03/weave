/**
 * Node splitting: a plain node must not slow traffic.
 *
 * Corridor A: change 'none' — one link 'main' of length L.
 * Corridor B: change 'width' with toWidthM = W, toLanes = n — the same road cut into
 *   up [0, atM] → taper (movement, bands [0, W] → [0, W]) [atM, atM + taperM] → down,
 *   total length L (§2.6). Same seed, demand, composition and mode.
 * Generation is identical: one 'in' zone (originIndex 0), one OD row, and the §2.1 draw order
 * does not depend on link ids, so vehicle k has the same id, class and arrival time in both.
 *
 * What theory guarantees, and what we assert:
 * 1. A vehicle that is alone (no leader within the §1.6 look-ahead, nobody to interact with)
 *    accelerates by the free-road IDM term, which depends on v only. Its speed sequence is the
 *    same recursion in A and B, so the speeds agree to rounding, its cumulative position
 *    (s + length of the segments before) agrees to rounding (≪ 1e-9 m), and its exit is
 *    detected in the same step or, if the front lands within rounding distance of the end, in
 *    the adjacent one: |tExit_A − tExit_B| ≤ dt.
 * 2. With demand, a vehicle is "isolated" when no other vehicle is ever within 200 m of it
 *    (front-to-front, cumulative positions) in either run: 200 − ℓ > D = max(150, v0²/(2b) + 50)
 *    = 150 m, so it never has a leader and is never anyone's leader. Lateral choices may differ
 *    between A and B (the insertion leader search covers only the origin link, which is shorter
 *    in B) but do not affect a free vehicle's speed. Isolated vehicles that were inserted at the
 *    same speed then satisfy 1.; interacting vehicles are not compared (their trajectories
 *    depend on lateral positions, which can legitimately differ).
 * Speeds use v0 = 15 m/s < speedLimitMps = 40 m/s so the §1.3 speed cap cannot bind on links.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type Change, type M2Sim } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };
const CLASSES = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2 }]);
const L = 1000;
const AT = 400;
const TAPER = 50;
const DT = 0.2;
const SPLIT: Change = { kind: 'width', atM: AT, toWidthM: 7, toLanes: 2, taperM: TAPER };
const OFFSET: Record<string, number> = { main: 0, up: 0, taper: AT, down: AT + TAPER };

const make = (change: Change, mode: 'strip' | 'lane', rateVph = 0, seed = 1): M2Sim =>
  makeSim(corridorScenario({ lengthM: L, widthM: 7, lanes: 2, change, mode, rateVph, seed }), CLASSES);

describe('node splitting: single vehicle (exact)', () => {
  for (const mode of ['strip', 'lane'] as const) {
    it(`${mode}: same speeds, same cumulative positions, exit within one step`, () => {
      const A = make({ kind: 'none' }, mode);
      const B = make(SPLIT, mode);
      // premise: segment lengths as in §2.6
      const taper = B.network.movements.find((m) => m.id === 'taper')!;
      expect(taper.path[0]![0]).toBeCloseTo(AT, 9);
      expect(taper.path[taper.path.length - 1]![0]).toBeCloseTo(AT + TAPER, 9);
      A.addVehicle({ classId: 'car', link: 'main', s: 10, y: 1.75, v: 5 });
      B.addVehicle({ classId: 'car', link: 'up', s: 10, y: 1.75, v: 5 });
      let exitA = -1;
      let exitB = -1;
      const linksB = new Set<string>();
      for (let k = 1; k <= 2000 && (exitA < 0 || exitB < 0); k++) {
        A.advance(1);
        B.advance(1);
        const a = A.vehicles()[0];
        const b = B.vehicles()[0];
        if (!a && exitA < 0) exitA = k;
        if (!b && exitB < 0) exitB = k;
        if (a && b) {
          linksB.add(b.link);
          expect(Math.abs(a.v - b.v)).toBeLessThanOrEqual(1e-12);
          expect(Math.abs(a.s - (b.s + OFFSET[b.link]!))).toBeLessThanOrEqual(1e-9);
          expect(b.y).toBe(a.y);
        }
      }
      expect([...linksB].sort()).toEqual(['down', 'taper', 'up']);
      expect(exitA).toBeGreaterThan(0);
      expect(Math.abs(exitA - exitB)).toBeLessThanOrEqual(1);
    });
  }
});

describe('node splitting: low demand, isolated vehicles', () => {
  for (const mode of ['strip', 'lane'] as const) {
    it(`${mode}: isolated vehicles have equal speeds and travel times within dt`, () => {
      const A = make({ kind: 'none' }, mode, 30, 17);
      const B = make(SPLIT, mode, 30, 17);
      const notIsolated = new Set<number>();
      const firstV = new Map<number, [number | undefined, number | undefined]>();
      const speedDiff = new Map<number, number>();
      const check = (sim: M2Sim, which: 0 | 1) => {
        const vs = sim.vehicles().map((v) => ({ id: v.id, x: v.s + OFFSET[v.link]!, v: v.v }));
        for (let i = 0; i < vs.length; i++) {
          for (let j = i + 1; j < vs.length; j++) {
            if (Math.abs(vs[i]!.x - vs[j]!.x) < 200) {
              notIsolated.add(vs[i]!.id);
              notIsolated.add(vs[j]!.id);
            }
          }
          const f = firstV.get(vs[i]!.id) ?? [undefined, undefined];
          if (f[which] === undefined) f[which] = vs[i]!.v;
          firstV.set(vs[i]!.id, f);
        }
        return new Map(vs.map((v) => [v.id, v.v]));
      };
      for (let k = 0; k < 5400 / DT; k++) {
        A.advance(1);
        B.advance(1);
        const va = check(A, 0);
        const vb = check(B, 1);
        for (const [id, v] of va) {
          const w = vb.get(id);
          if (w !== undefined) speedDiff.set(id, Math.max(speedDiff.get(id) ?? 0, Math.abs(v - w)));
        }
      }
      // generation is identical
      expect(B.generatedLog().map((r) => [r.id, r.tGen, r.classId])).toEqual(A.generatedLog().map((r) => [r.id, r.tGen, r.classId]));
      const tb = new Map(B.trips().map((t) => [t.id, t]));
      let compared = 0;
      for (const ta of A.trips()) {
        const t = tb.get(ta.id);
        if (!t || notIsolated.has(ta.id)) continue;
        const f = firstV.get(ta.id)!;
        if (f[0] !== f[1]) continue; // inserted at different speeds (origin-link scope), see header
        expect(Math.abs(ta.tInsert - t.tInsert)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(ta.tExit - ta.tInsert - (t.tExit - t.tInsert))).toBeLessThanOrEqual(DT + 1e-9);
        expect(speedDiff.get(ta.id)!).toBeLessThanOrEqual(1e-12);
        compared++;
      }
      // λT = 45 vehicles; each is isolated with probability ≈ exp(−2·13.3 s/120 s) ≈ 0.8
      // (200 m at 15 m/s = 13.3 s on either side), so ~36 are expected; ≥ 10 is a 9σ-safe floor.
      expect(compared).toBeGreaterThanOrEqual(10);
    });
  }
});
