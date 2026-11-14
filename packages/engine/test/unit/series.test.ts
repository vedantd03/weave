/**
 * series() (docs/MODEL.md §2.7): rows per 60 s window. Checks that follow exactly from the
 * definitions:
 *   - windows [t0, t1) tile time in 60 s steps;
 *   - exitFlowVph = exited·3600/60;
 *   - window sums equal the counters; end-of-window onNetwork/entryQueue equal counters() then;
 *   - per window: onNetwork_k = onNetwork_{k−1} + inserted_k − exited_k and
 *     entryQueue_k = entryQueue_{k−1} + generated_k − inserted_k;
 *   - densityPerKm and meanSpeedMps are time averages over the window's steps of
 *     onNetwork/(total link km) and of the space-mean speed. We sample after every step whose
 *     end time lies in (t0, t1] (the state "during" that step's slot) and compare within 1e-9.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type M2Sim } from '../helpers/m2.ts';
import { ringClassSet, ringScenario } from '../helpers/ring.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };
const DT = 0.2;
const PER_WIN = 60 / DT;

describe('series(): ring (constant population, exact density and mean speed)', () => {
  it('density = N/(L/1000) in every window; meanSpeed = time-average of the space-mean speed', () => {
    const L = 500;
    const sim = makeSim(
      ringScenario({ circumferenceM: L, densityPerKm: 40, jitterM: 2, seed: 3 }),
      ringClassSet({ v0: 15, T: 1.2, s0: 2, a: 1, b: 1.5 }, 5),
    ) as M2Sim;
    const N = sim.vehicleCount();
    expect(N).toBe(20);
    const sampledMean: number[] = [];
    let acc = 0;
    for (let k = 1; k <= 5 * PER_WIN; k++) {
      sim.advance(1);
      const vs = sim.vehicles();
      acc += vs.reduce((a, v) => a + v.v, 0) / vs.length;
      if (k % PER_WIN === 0) {
        sampledMean.push(acc / PER_WIN);
        acc = 0;
      }
    }
    const rows = sim.series();
    expect(rows.length).toBe(5);
    rows.forEach((r, k) => {
      expect(r.t0).toBeCloseTo(60 * k, 9);
      expect(r.t1).toBeCloseTo(60 * (k + 1), 9);
      expect(r.densityPerKm).toBeCloseTo(N / (L / 1000), 9);
      expect(Math.abs(r.meanSpeedMps - sampledMean[k]!)).toBeLessThanOrEqual(1e-9);
      expect(r.onNetwork).toBe(N);
      expect(r.exited).toBe(0);
      expect(r.exitFlowVph).toBe(0);
      expect(r.entryQueue).toBe(0);
    });
  });
});

describe('series(): corridor with demand', () => {
  it('windows, flows, sums and per-window balances', () => {
    const LEN = 800;
    const sim = makeSim(
      corridorScenario({ lengthM: LEN, widthM: 3.5, lanes: 1, rateVph: 2400, mode: 'lane', seed: 21 }),
      classSet([{ id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2 }]),
    );
    const ends: ReturnType<M2Sim['counters']>[] = [];
    const density: number[] = [];
    let acc = 0;
    for (let k = 1; k <= 10 * PER_WIN; k++) {
      sim.advance(1);
      acc += sim.vehicleCount() / (LEN / 1000);
      if (k % PER_WIN === 0) {
        ends.push(sim.counters());
        density.push(acc / PER_WIN);
        acc = 0;
      }
    }
    const rows = sim.series();
    expect(rows.length).toBe(10);
    let prevOn = 0;
    let prevQ = 0;
    rows.forEach((r, k) => {
      expect(r.t0).toBeCloseTo(60 * k, 9);
      expect(r.t1).toBeCloseTo(60 * (k + 1), 9);
      expect(r.exitFlowVph).toBeCloseTo((r.exited * 3600) / 60, 9);
      expect(r.onNetwork).toBe(ends[k]!.onNetwork);
      expect(r.entryQueue).toBe(ends[k]!.entryQueue);
      expect(r.onNetwork).toBe(prevOn + r.inserted - r.exited);
      expect(r.entryQueue).toBe(prevQ + r.generated - r.inserted);
      expect(Math.abs(r.densityPerKm - density[k]!)).toBeLessThanOrEqual(1e-9);
      prevOn = r.onNetwork;
      prevQ = r.entryQueue;
    });
    const c = sim.counters();
    expect(rows.reduce((a, r) => a + r.generated, 0)).toBe(c.generated);
    expect(rows.reduce((a, r) => a + r.exited, 0)).toBe(c.exited);
    expect(rows.reduce((a, r) => a + r.inserted, 0)).toBe(c.generated - c.entryQueue);
    expect(c.exited).toBeGreaterThan(0);
  });
});
