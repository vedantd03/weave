/**
 * Saturated plain node (committed separately, after the M3 suite).
 *
 * A = plain corridor, 7.0 m, 2 lanes (change 'none'). Two variants of B, same length, demand,
 * classes (defaultClasses(), Chennai shares), mode and seed (CRN-paired):
 *   B_same:   split by a width change 7.0 → 7.0 m, 2 → 2 lanes (a plain node + taper);
 *   B_narrow: width change 7.2 → 7.0 m, 2 → 2 lanes, band [0, 7.0].
 * Theory:
 *   - B_same: identical carriageways have identical capacity, so the saturated discharge rate
 *     and the entry-queue behaviour must agree with A (two-sided).
 *   - B_narrow: the downstream carriageway is A's; upstream is wider, and every inserted body
 *     already fits the band (insertion is band-only, §2.3), so nobody has to merge. B's
 *     saturated throughput must be ≥ A's, and its entry queue must not exceed A's (one-sided).
 *   - Collision guard (§1.4, ADR-015): a rare safety net. ADR-015 measured 0 activations in
 *     lane mode and 0.01–0.1% of vehicle-steps in strip mode. We require, per seed,
 *     guard_B ≤ 10·guard_A + 0.001·vehicleSteps_B: at most an order of magnitude above the plain
 *     road, plus the 0.1% rare-net budget. Binding orders of magnitude more often than on the
 *     plain road indicates a modelling defect at the node.
 * Demand 6000 veh/h saturates a 7 m road. Throughput = exits in [WARM, WARM + WIN) × 3600/WIN.
 * Tolerance: paired differences d_s = B_s − A_s over n = 5 seeds; t interval
 * t_{0.9995, 4}·sd(d)/√n (two-sided p = 0.001, t = 8.610) plus a counting term of two
 * vehicles per window (2·3600/WIN veh/h) for throughput and one vehicle for the queue mean.
 * Measured values are printed: grep NODE_SATURATION.
 */
import { describe, expect, it } from 'vitest';
import { defaultClasses } from '../../src/index.ts';
import { corridorScenario, makeSim, type Change } from '../helpers/m2.ts';
import type { M3Sim } from '../helpers/m3.ts';

const DT = 0.2;
const WARM = 300;
const WIN = 900;
const SEEDS = [1, 2, 3, 4, 5];
const T_4 = 8.61;
const COMPOSITION = { motorcycle: 0.5641, car: 0.2662, auto: 0.1218, bus: 0.0316, truck: 0.003, lcv: 0.0133 };
const log = (line: string) => (globalThis as unknown as { console: { log(s: string): void } }).console.log(line);

interface Run {
  flowVph: number;
  meanQueue: number;
  guard: number;
  vehicleSteps: number;
}

function run(widthM: number, change: Change, mode: 'strip' | 'lane', seed: number): Run {
  const sim = makeSim(
    corridorScenario({ lengthM: 600, widthM, lanes: 2, change, rateVph: 6000, mode, seed, composition: COMPOSITION }),
    defaultClasses(),
  ) as unknown as M3Sim;
  sim.advance(Math.round(WARM / DT));
  const e0 = sim.counters().exited;
  let q = 0;
  let vehicleSteps = 0;
  const n = Math.round(WIN / DT);
  for (let k = 0; k < n; k++) {
    sim.advance(1);
    q += sim.counters().entryQueue;
    vehicleSteps += sim.vehicleCount();
  }
  return {
    flowVph: ((sim.counters().exited - e0) * 3600) / WIN,
    meanQueue: q / n,
    guard: sim.diagnostics().guardActivations,
    vehicleSteps,
  };
}

function paired(a: number[], b: number[]) {
  const d = b.map((x, i) => x - a[i]!);
  const m = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) * (x - m), 0) / (d.length - 1));
  return { mean: m, half: (T_4 * sd) / Math.sqrt(d.length) };
}

const PLAIN: Change = { kind: 'none' };
const SAME: Change = { kind: 'width', atM: 300, toWidthM: 7.0, toLanes: 2, taperM: 30 };
const NARROW: Change = { kind: 'width', atM: 300, toWidthM: 7.0, toLanes: 2, taperM: 30 };
const COUNT_FLOW = (2 * 3600) / WIN;
const COUNT_QUEUE = 1;

for (const mode of ['strip', 'lane'] as const) {
  describe(`saturated node, ${mode} mode`, { timeout: 300_000 }, () => {
    let memo: Run[] | null = null;
    const plainRuns = () => (memo ??= SEEDS.map((s) => run(7.0, PLAIN, mode, s)));

    it('same-width split (7.0 → 7.0): throughput and entry queue equal the plain road', () => {
      const A = plainRuns();
      const B = SEEDS.map((s) => run(7.0, SAME, mode, s));
      const f = paired(A.map((r) => r.flowVph), B.map((r) => r.flowVph));
      const q = paired(A.map((r) => r.meanQueue), B.map((r) => r.meanQueue));
      log(`NODE_SATURATION mode=${mode} case=same A_flow=${A.map((r) => r.flowVph).join('/')} B_flow=${B.map((r) => r.flowVph).join('/')} A_queue=${A.map((r) => r.meanQueue.toFixed(1)).join('/')} B_queue=${B.map((r) => r.meanQueue.toFixed(1)).join('/')} A_guard=${A.map((r) => r.guard).join('/')} B_guard=${B.map((r) => r.guard).join('/')}`);
      expect(Math.abs(f.mean)).toBeLessThanOrEqual(f.half + COUNT_FLOW);
      expect(q.mean).toBeLessThanOrEqual(q.half + COUNT_QUEUE);
      B.forEach((b, i) => expect(b.guard).toBeLessThanOrEqual(10 * A[i]!.guard + 0.001 * b.vehicleSteps));
    });

    it('narrowing 7.2 → 7.0 (band [0, 7.0]): throughput ≥ plain 7.0 road, queue not larger, guard rare', () => {
      const A = plainRuns();
      const B = SEEDS.map((s) => run(7.2, NARROW, mode, s));
      const f = paired(A.map((r) => r.flowVph), B.map((r) => r.flowVph));
      const q = paired(A.map((r) => r.meanQueue), B.map((r) => r.meanQueue));
      log(`NODE_SATURATION mode=${mode} case=narrow A_flow=${A.map((r) => r.flowVph).join('/')} B_flow=${B.map((r) => r.flowVph).join('/')} A_queue=${A.map((r) => r.meanQueue.toFixed(1)).join('/')} B_queue=${B.map((r) => r.meanQueue.toFixed(1)).join('/')} A_guard=${A.map((r) => r.guard).join('/')} B_guard=${B.map((r) => r.guard).join('/')}`);
      expect(f.mean).toBeGreaterThanOrEqual(-(f.half + COUNT_FLOW));
      expect(q.mean).toBeLessThanOrEqual(q.half + COUNT_QUEUE);
      B.forEach((b, i) => expect(b.guard).toBeLessThanOrEqual(10 * A[i]!.guard + 0.001 * b.vehicleSteps));
    });
  });
}
