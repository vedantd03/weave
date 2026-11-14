/**
 * Insertion from the entry queue (docs/MODEL.md §2.3).
 *
 * Expected relations, checked for every inserted vehicle from the state right after the step
 * in which it appears (insertion is step 7 of §2.5, after integration and transfer, so the
 * post-step view is exactly the state the insertion saw):
 *   - front at s = length;
 *   - v_ins = min(v0_eff, v_L) for the chosen candidate's leader L (v0_eff with no leader);
 *   - feasibility gap = rear_L − length ≥ s0 + v_ins·T (the driver's parameters);
 *   - strip mode: y is a candidate centre h + m·w with y + h ≤ W, and its gap is the largest
 *     among the feasible candidates; lane mode: y is a lane centre;
 *   - FIFO: insertion order = generation order (head-of-line blocking).
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type ClassSpec, type GenRecord, type VView } from '../helpers/m2.ts';
import { layoutRef, occupiedRef } from '../helpers/strips-ref.ts';

const CAR = { v0: 15, T: 1.5, s0: 2, a: 1.5, b: 2 };
const BUS = { v0: 12, T: 3, s0: 3, a: 1, b: 1.5 };

interface Leader {
  gap: number;
  vL: number | null;
}
/** §1.6 leader over `others` on the origin link for a candidate span, entering front = len. */
function leaderFor(others: VView[], span: [number, number], len: number): Leader {
  let best: VView | null = null;
  for (const o of others) {
    if (o.lo > span[1] || span[0] > o.hi) continue;
    if (!(o.s > len)) continue;
    if (!best || o.s - o.length < best.s - best.length) best = o;
  }
  return best ? { gap: best.s - best.length - len, vL: best.v } : { gap: Infinity, vL: null };
}

describe('insertion: jammed single-lane origin (lane mode)', () => {
  // Width change 3.5 m → 3.0 m at 200 m: band [0, 3.0]. Both classes are 3.2 m wide, so no
  // vehicle can ever enter the taper (§2.2): the first one stops at the end of 'up' and the
  // link fills. Two classes with different T make head-of-line blocking matter.
  const classes = classSet([
    { id: 'car', length: 4.5, width: 3.2, idm: CAR, c0: 0, c1: 0 },
    { id: 'bus', length: 10, width: 3.2, idm: BUS, c0: 0, c1: 0 },
  ]);
  const UP = 200;
  const RATE = 1800; // veh/h

  it('every insertion obeys s = length, v_ins = min(v0, v_L), gap ≥ s0 + v_ins·T, FIFO; the queue grows', () => {
    const sim = makeSim(
      corridorScenario({
        lengthM: 400,
        widthM: 3.5,
        lanes: 1,
        change: { kind: 'width', atM: UP, toWidthM: 3.0, toLanes: 1, taperM: 30 },
        rateVph: RATE,
        mode: 'lane',
        composition: { car: 0.5, bus: 0.5 },
        seed: 77,
      }),
      classes,
    );
    const seen = new Set<number>();
    const insertedOrder: number[] = [];
    let log = new Map<number, GenRecord>();
    let queueAt300 = -1;
    let checkedV = 0;
    for (let k = 1; k <= 3000; k++) {
      sim.advance(1);
      const vs = sim.vehicles();
      const fresh = vs.filter((v) => !seen.has(v.id));
      if (fresh.length) log = new Map(sim.generatedLog().map((r) => [r.id, r]));
      // one lane: after an insertion the next head sees a leader with rear at 0 → infeasible
      expect(fresh.length).toBeLessThanOrEqual(1);
      for (const v of fresh) {
        seen.add(v.id);
        insertedOrder.push(v.id);
        const rec = log.get(v.id)!;
        expect(v.link).toBe('up');
        expect(v.s).toBeCloseTo(v.length, 9);
        expect(v.y).toBeCloseTo(1.75, 9);
        const ld = leaderFor(
          vs.filter((o) => o.id !== v.id && o.link === 'up'),
          [0, 0],
          v.length,
        );
        expect(ld.gap).toBeGreaterThanOrEqual(rec.s0 + v.v * rec.T - 1e-9);
        if (ld.vL === null) {
          expect(v.v).toBe(rec.v0);
        } else if (ld.gap <= 150) {
          // (for a leader farther than the §1.6 look-ahead the spec does not say whether the
          // insertion leader search is capped, so only near leaders are checked exactly)
          expect(v.v).toBe(Math.min(rec.v0, ld.vL));
          checkedV++;
        }
      }
      for (const v of vs) expect(v.s).toBeLessThan(UP + 1e-9);
      const c = sim.counters();
      expect(c.exited).toBe(0);
      if (k === 1500) queueAt300 = c.entryQueue;
    }
    // FIFO: the i-th insertion is the i-th generated vehicle (ids originIndex·2^20 + k, origin 0)
    expect(insertedOrder).toEqual(insertedOrder.map((_, i) => i));
    expect(checkedV).toBeGreaterThan(10);
    const c = sim.counters();
    // Poisson: generated ~ λT = 300 ± √300; 5σ lower bound 213.
    expect(c.generated).toBeGreaterThan(213);
    // At most ⌊UP/ℓ_min⌋ + 1 = 45 non-overlapping vehicles fit on 'up' (no collisions), and none
    // ever leaves, so the rest must be queued.
    expect(c.onNetwork).toBeLessThanOrEqual(Math.floor(UP / 4.5) + 1);
    expect(c.entryQueue).toBe(c.generated - c.onNetwork);
    expect(c.entryQueue).toBeGreaterThan(c.generated - 46);
    expect(c.entryQueue).toBeGreaterThan(queueAt300);
  });
});

describe('insertion: strip-mode candidate choice', () => {
  const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: CAR, c0: 0.2, c1: 0 }]);
  const W = 7;
  const L = layoutRef(W, 0.3);
  const h = 0.9 + 0.2;
  const M = Math.floor((W - 2 * h) / L.w + 1e-9); // candidates m = 0..M
  const cands = Array.from({ length: M + 1 }, (_, m) => h + m * L.w).filter((y) => y + h <= W + 1e-12);

  it('y is a candidate centre; its gap is maximal among feasible candidates; v = v_ins', () => {
    const sim = makeSim(corridorScenario({ lengthM: 1000, widthM: W, lanes: 2, rateVph: 2400, mode: 'strip', seed: 9 }), classes);
    const seen = new Set<number>();
    let checked = 0;
    for (let k = 1; k <= 900; k++) {
      sim.advance(1);
      const vs = sim.vehicles();
      const fresh = vs.filter((v) => !seen.has(v.id));
      for (const v of fresh) seen.add(v.id);
      if (fresh.length !== 1) continue; // same-step co-insertions: order-dependent, skipped
      const v = fresh[0]!;
      const m = (v.y - h) / L.w;
      expect(Math.abs(m - Math.round(m))).toBeLessThan(1e-9);
      expect(v.y + h).toBeLessThanOrEqual(W + 1e-9);
      const others = vs.filter((o) => o.id !== v.id && o.link === 'main');
      const evals = cands.map((y) => {
        const ld = leaderFor(others, occupiedRef(y, 1.8, 0.2, L), v.length);
        const vIns = ld.vL === null ? CAR.v0 : Math.min(CAR.v0, ld.vL);
        return { y, gap: ld.gap, vIns, feasible: ld.gap >= CAR.s0 + vIns * CAR.T };
      });
      const chosen = evals.find((e) => Math.abs(e.y - v.y) < 1e-9)!;
      expect(chosen).toBeDefined();
      expect(chosen.feasible).toBe(true);
      const best = Math.max(...evals.filter((e) => e.feasible).map((e) => e.gap));
      if (best === Infinity) expect(chosen.gap).toBe(Infinity);
      else expect(chosen.gap).toBeGreaterThanOrEqual(best - 1e-9);
      if (chosen.gap <= 150 || chosen.gap === Infinity) expect(v.v).toBeCloseTo(chosen.vIns, 12);
      expect(v.s).toBeCloseTo(v.length, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
