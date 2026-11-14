/**
 * T16 — spillback shockwave. Single class, lane mode, one lane, homogeneous drivers.
 *
 * Setup: corridor 'width' 3.5 m → 3.0 m at 1500 m; the class is 3.2 m wide, so no vehicle can
 * enter the taper (§2.2) and a standing queue (q2 = 0, k2 = 1/(s0 + ℓ), the jam density of the
 * IDM equilibrium FD) grows upstream. Arrivals: Poisson, q1 = 180 veh/h; upstream vehicles drive
 * alone at v0 (gaps ≫ the look-ahead), so k1 = q1/v0. Lighthill–Whitham–Richards:
 *   w = (q2 − q1)/(k2 − k1) = −q1 / (1/(s0 + ℓ) − q1/v0).
 *
 * Microscopically, the n-th vehicle stops at x_n = x_1 − (n − 1)(s0 + ℓ) and reaches the queue at
 * t_n = tIns_n + (x_n − x_ref)/v0 + c, where c is the same for every vehicle that approaches
 * the standing tail alone (canonical approach). With ζ = T·√(a/(2 s0)) = 1.41 the approach does
 * not overshoot and settles to the gap s0 (T3). For two such "isolated" vehicles a < b:
 *   t_b − t_a = (tGen_b − tGen_a) + (x_b − x_a)/v0     (measured w = (x_b − x_a)/(t_b − t_a)),
 * which is the LWR relation with q̂1 = (b − a)/(tGen_b − tGen_a) and x_b − x_a = −(b − a)(s0 + ℓ).
 * (Vehicles arriving within a few seconds of each other may wait briefly in the entry queue;
 * the isolated endpoints never do, which the test checks.)
 * Tolerance 3·dt: insertion happens at the first step end after tGen (phase < dt), the join
 * instant (first step with v < v0/2) is detected to < dt, and the sampled approach depends on
 * the phase of the step grid by < dt.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 2, s0: 2, a: 2, b: 2 };
const LEN = 4.5;
const LAMBDA = IDM.s0 + LEN;
const DT = 0.2;

describe('T16 spillback shockwave speed', () => {
  it('queue tail moves at (q2 − q1)/(k2 − k1) with jam density 1/(s0 + ℓ)', () => {
    const sim = makeSim(
      corridorScenario({
        lengthM: 2000, widthM: 3.5, lanes: 1, change: { kind: 'width', atM: 1500, toWidthM: 3.0, toLanes: 1, taperM: 20 },
        rateVph: 180, mode: 'lane', seed: 16,
      }),
      classSet([{ id: 'car', length: LEN, width: 3.2, idm: IDM, c0: 0 }]),
    );
    const join = new Map<number, number>();
    const inserted = new Map<number, number>();
    const STEPS = 2400 / DT;
    for (let k = 1; k <= STEPS; k++) {
      sim.advance(1);
      for (const v of sim.vehicles()) {
        if (!inserted.has(v.id)) inserted.set(v.id, sim.t);
        if (!join.has(v.id) && v.v < IDM.v0 / 2) join.set(v.id, sim.t);
      }
    }
    const log = sim.generatedLog();
    const pos = new Map(sim.vehicles().map((v) => [v.id, v.s]));
    // the queue never reached the entrance region (premise for immediate insertion at v0)
    expect(Math.min(...pos.values())).toBeGreaterThan(300);
    // settled jam spacing s0 + ℓ between consecutive vehicles that joined ≥ 60 s before the end
    const settled = log.filter((r) => join.has(r.id) && join.get(r.id)! < sim.t - 60);
    for (let i = 1; i < settled.length; i++) {
      expect(Math.abs(pos.get(settled[i - 1]!.id)! - pos.get(settled[i]!.id)! - LAMBDA)).toBeLessThan(1e-3);
    }
    // isolated vehicles: predecessor generated ≥ 40 s earlier (it has long stopped when they arrive)
    const iso = settled.filter((r, i) => i > 0 && r.tGen - settled[i - 1]!.tGen >= 40);
    expect(iso.length).toBeGreaterThanOrEqual(2);
    const A = iso[0]!;
    const B = iso[iso.length - 1]!;
    // premise: both were inserted at the first step end after generation, at v0
    for (const r of [A, B]) {
      expect(inserted.get(r.id)! - r.tGen).toBeGreaterThanOrEqual(-1e-9);
      expect(inserted.get(r.id)! - r.tGen).toBeLessThan(DT + 1e-9);
    }
    const nA = log.findIndex((r) => r.id === A.id);
    const nB = log.findIndex((r) => r.id === B.id);
    expect(nB - nA).toBeGreaterThanOrEqual(10);
    const dx = pos.get(B.id)! - pos.get(A.id)!;
    expect(Math.abs(dx + (nB - nA) * LAMBDA)).toBeLessThan(1e-2);
    const dtMeas = join.get(B.id)! - join.get(A.id)!;
    const dtTheory = B.tGen - A.tGen + dx / IDM.v0;
    expect(Math.abs(dtMeas - dtTheory)).toBeLessThanOrEqual(3 * DT);
    // the same statement as a wave speed
    const q1 = (nB - nA) / (B.tGen - A.tGen);
    const wTheory = -q1 / (1 / LAMBDA - q1 / IDM.v0);
    const wMeas = dx / dtMeas;
    expect(wMeas).toBeLessThan(0);
    expect(Math.abs(wMeas - wTheory) / Math.abs(wTheory)).toBeLessThanOrEqual((3 * DT) / Math.abs(dtTheory) + 2e-3);
  });
});
