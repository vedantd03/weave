/**
 * Experiment API (docs/MODEL.md §5.2): runReplicate / summarize / compare.
 *
 * Every metric is recomputed in the test from an equivalent manual createSim run (same scenario
 * and seed) using sim.trips(), sim.generatedLog(), sim.series(), counters() and gridlock():
 *   window W = [warmupS, durationS]; trips count when tGen ∈ W;
 *   meanDelayS = mean over ALL trips generated in W of tExit − tGen − freeFlowS (completed) or
 *   durationS − tGen − freeFlowS (unfinished: in an entry queue or on the network at durationS,
 *   freeFlowS from generatedLog); meanDelayCompletedS = the same over completed trips only;
 *   meanTravelTimeS = mean(tExit − tGen) over completed trips (NaN if none);
 *   gridlocked = 1 if lockedJunctions > 0 else 0; completedTrips / incompleteTrips = generated in
 *   W and exited / not exited by durationS; throughputVph = exits in W·3600/|W|;
 *   meanSpeedKmh = 3.6·mean of meanSpeedMps over the series rows inside W; maxEntryQueue = max
 *   entryQueue over those rows; lockedJunctions = gridlock()?.junctions.length ?? 0;
 *   guardPer10k = guardActivations per 10 000 vehicle-steps over the whole run (Σ vehicleCount()
 *   after every step).
 * Counts must match exactly, means to 1e-9 relative (summation order). warmupS and durationS
 * are multiples of 60 s so the window is made of whole series rows.
 */
import { describe, expect, it } from 'vitest';
import { compare, runReplicate, summarize } from '../../src/stats/experiment.ts';
import { pairedCI } from '../../src/stats/ci.ts';
import type { ScenarioInput } from '../../src/schema/index.ts';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';
import { ARM, junctionScenario, type M3Sim } from '../helpers/m3.ts';
import { Network } from '../../src/schema/index.ts';
import { meanCIRef } from '../helpers/stats-ref.ts';

const DT = 0.2;
const CLASSES = classSet([
  { id: 'car', length: 4.5, width: 1.8, idm: { v0: 13, T: 1.2, s0: 2, a: 1.5, b: 2 } },
  { id: 'motorcycle', length: 2, width: 0.8, idm: { v0: 14, T: 1.0, s0: 1.5, a: 2, b: 2.5 } },
]);
/** §5.2 MetricId, spelled out locally so the test's types do not depend on the module. */
type MetricId =
  | 'meanDelayS' | 'meanDelayCompletedS' | 'gridlocked' | 'meanTravelTimeS' | 'throughputVph' | 'meanSpeedKmh' | 'maxEntryQueue'
  | 'completedTrips' | 'incompleteTrips' | 'lockedJunctions' | 'guardPer10k';
const METRICS: MetricId[] = [
  'meanDelayS', 'meanDelayCompletedS', 'gridlocked', 'meanTravelTimeS', 'throughputVph', 'meanSpeedKmh', 'maxEntryQueue',
  'completedTrips', 'incompleteTrips', 'lockedJunctions', 'guardPer10k',
];
const timed = (sc: ScenarioInput, warmupS: number, durationS: number): ScenarioInput => ({ ...sc, warmupS, durationS });

const corridor = (o: { lengthM?: number; rateVph?: number }) =>
  timed(
    corridorScenario({ lengthM: o.lengthM ?? 800, widthM: 3.5, lanes: 1, rateVph: o.rateVph ?? 900, mode: 'lane', seed: 1, composition: { car: 0.7, motorcycle: 0.3 } }),
    120,
    600,
  );
const junction = () =>
  timed(
    junctionScenario({
      arms: [ARM(0), ARM(90), ARM(180), ARM(270)],
      od: [
        { origin: 'arm0_in', destination: 'arm2_out', rateVph: 400 },
        { origin: 'arm1_in', destination: 'arm3_out', rateVph: 300 },
        { origin: 'arm2_in', destination: 'arm1_out', rateVph: 200 },
      ],
      composition: { car: 0.7, motorcycle: 0.3 },
      mode: 'lane',
    }),
    120,
    600,
  );

interface Manual {
  metrics: Record<MetricId, number>;
  guardWholeRun: number;
  guardWindow: number;
  meanQueueTime: number;
}

function manual(scenario: ScenarioInput, seed: number, network?: Network, classes = CLASSES): Manual {
  const sim = makeSim({ ...scenario, seed }, classes, network) as unknown as M3Sim;
  const w = scenario.warmupS!;
  const D = scenario.durationS;
  let vsAll = 0;
  let vsWin = 0;
  const nW = Math.round(w / DT);
  const nD = Math.round(D / DT);
  let exitedAtW = 0;
  for (let k = 1; k <= nD; k++) {
    sim.advance(1);
    const c = sim.vehicleCount();
    vsAll += c;
    if (k > nW) vsWin += c;
    if (k === nW) exitedAtW = sim.counters().exited;
  }
  const inW = (t: number) => t >= w && t <= D;
  const trips = sim.trips().filter((t) => inW(t.tGen));
  const gen = sim.generatedLog().filter((r) => inW(r.tGen));
  const rows = sim.series().filter((r) => r.t0 >= w - 1e-9 && r.t1 <= D + 1e-9);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const guard = sim.diagnostics().guardActivations;
  const done = new Map(trips.map((t) => [t.id, t]));
  // generatedLog's freeFlowS is "computed as in trips()" (§2.7)
  for (const r of gen) if (done.has(r.id)) expect(Math.abs(r.freeFlowS - done.get(r.id)!.freeFlowS)).toBeLessThanOrEqual(1e-9);
  const allDelays = gen.map((r) => {
    const t = done.get(r.id);
    return t ? t.tExit - t.tGen - t.freeFlowS : D - r.tGen - r.freeFlowS;
  });
  const locked = sim.gridlock()?.junctions.length ?? 0;
  return {
    metrics: {
      meanDelayS: mean(allDelays),
      meanDelayCompletedS: mean(trips.map((t) => t.tExit - t.tGen - t.freeFlowS)),
      gridlocked: locked > 0 ? 1 : 0,
      meanTravelTimeS: mean(trips.map((t) => t.tExit - t.tGen)),
      throughputVph: ((sim.counters().exited - exitedAtW) * 3600) / (D - w),
      meanSpeedKmh: 3.6 * mean(rows.map((r) => r.meanSpeedMps)),
      maxEntryQueue: Math.max(...rows.map((r) => r.entryQueue)),
      completedTrips: trips.length,
      incompleteTrips: gen.length - trips.length,
      lockedJunctions: locked,
      guardPer10k: NaN, // definition of the vehicle-step base checked separately
    },
    guardWholeRun: (guard * 1e4) / vsAll,
    guardWindow: (guard * 1e4) / vsWin,
    meanQueueTime: mean(trips.map((t) => t.tInsert - t.tGen)),
  };
}

function expectSame(got: Record<MetricId, number>, m: Manual) {
  for (const k of METRICS) {
    if (k === 'guardPer10k') {
      // §5.2: activations per 10 000 vehicle-steps over the whole run
      expect(Math.abs(got[k] - m.guardWholeRun)).toBeLessThanOrEqual(1e-9 * Math.max(1, m.guardWholeRun));
      continue;
    }
    const e = m.metrics[k];
    if (Number.isNaN(e)) expect(got[k], k).toBeNaN();
    else expect(Math.abs(got[k] - e), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(e)));
  }
}

describe('runReplicate', () => {
  it('is deterministic: same seed → identical result', () => {
    const input = { scenario: corridor({}), classes: CLASSES };
    const a = runReplicate(input, 7);
    const b = runReplicate(input, 7);
    expect(a).toEqual(b);
    expect(a.seed).toBe(7);
    expect(runReplicate(input, 8)).not.toEqual(a);
  });

  it('corridor: every metric equals the manual computation from trips/series/counters', () => {
    const sc = corridor({});
    const r = runReplicate({ scenario: sc, classes: CLASSES }, 3);
    const m = manual(sc, 3);
    expect(m.metrics.completedTrips).toBeGreaterThan(20);
    expectSame(r.metrics, m);
  });

  it('generated junction: same, including lockedJunctions', () => {
    const sc = junction();
    const r = runReplicate({ scenario: sc, classes: CLASSES }, 5);
    const m = manual(sc, 5);
    expect(m.metrics.completedTrips).toBeGreaterThan(10);
    expectSame(r.metrics, m);
  });

  it('incomplete trips are counted (long corridor: trips generated late cannot finish)', () => {
    const sc = corridor({ lengthM: 2000 }); // ≈ 150 s travel, window ends at 600 s
    const r = runReplicate({ scenario: sc, classes: CLASSES }, 4);
    const m = manual(sc, 4);
    expect(m.metrics.incompleteTrips).toBeGreaterThan(5);
    expect(r.metrics.incompleteTrips).toBe(m.metrics.incompleteTrips);
    expect(r.metrics.completedTrips + r.metrics.incompleteTrips).toBe(m.metrics.completedTrips + m.metrics.incompleteTrips);
  });

  it('delay includes entry-queue time (demand above the single-lane insertion capacity)', () => {
    const sc = corridor({ rateVph: 3000 });
    const r = runReplicate({ scenario: sc, classes: CLASSES }, 2);
    const m = manual(sc, 2);
    expect(m.meanQueueTime).toBeGreaterThan(5); // premise: a real entry queue
    expectSame(r.metrics, m);
    // delay = queue time + time on the network beyond free flow; the latter is ≥ −length/v0
    // (the front starts at s = length), so delay ≥ queue time − 1 s (completed trips)
    expect(r.metrics.meanDelayCompletedS).toBeGreaterThanOrEqual(m.meanQueueTime - 1);
    // the queue keeps growing, so the vehicles still queued at the end add even larger delays
    expect(r.metrics.incompleteTrips).toBeGreaterThan(0);
    expect(r.metrics.meanDelayS).toBeGreaterThan(r.metrics.meanDelayCompletedS);
  });
});

describe('gridlocked runs', () => {
  // Two parts (custom network). Part 1: link a into junction J with two movements whose bands
  // are [0, 3.0]; every vehicle from 'in' is a 3.2 m truck (compositionByOrigin), so none can
  // ever enter J (§2.2): the queue on a stalls and J locks 300 s later (§3.4 item 6). Part 2:
  // an unrelated corridor c with ordinary cars keeps completing trips with small delays.
  // meanDelayS counts the stuck trips with durationS − tGen − freeFlowS (≈ hundreds of s),
  // meanDelayCompletedS only the corridor's (≈ seconds).
  type P = [number, number];
  const link = (id: string, from: string, to: string, pl: P[], w: number) => ({ id, from, to, polyline: pl, widthM: w, lanes: 1, speedLimitMps: 13 });
  const mv = (id: string, toLink: string, path: P[]) => ({
    id, node: 'J', fromLink: 'a', toLink, path, widthM: 3.0, fromLateral: [0, 3.0] as P, toLateral: [0, 3.0] as P, control: 'free' as const,
  });
  const net = Network.parse({
    version: 1, id: 'lock', name: 'lock',
    nodes: [
      { id: 'J0', x: 0, y: 0, kind: 'boundary' }, { id: 'J', x: 300, y: 0, kind: 'diverge' },
      { id: 'J1', x: 400, y: 20, kind: 'boundary' }, { id: 'J2', x: 400, y: -20, kind: 'boundary' },
      { id: 'P0', x: 0, y: 200, kind: 'boundary' }, { id: 'P1', x: 400, y: 200, kind: 'boundary' },
    ],
    links: [
      link('a', 'J0', 'J', [[0, 0], [300, 0]], 3.5),
      link('b', 'J', 'J1', [[305, 1], [400, 20]], 3.0),
      link('b2', 'J', 'J2', [[305, -1], [400, -20]], 3.0),
      link('c', 'P0', 'P1', [[0, 200], [400, 200]], 3.5),
    ],
    movements: [mv('m', 'b', [[300, 0], [305, 1]]), mv('m2', 'b2', [[300, 0], [305, -1]])],
    zones: [
      { id: 'in', link: 'a', role: 'in' }, { id: 'out1', link: 'b', role: 'out' },
      { id: 'in2', link: 'c', role: 'in' }, { id: 'out2', link: 'c', role: 'out' },
    ],
  });
  const classes = classSet([
    { id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } },
    { id: 'truck', length: 9, width: 3.2, idm: { v0: 10, T: 2, s0: 2, a: 1, b: 2 } },
  ]);
  const scenario: ScenarioInput = {
    version: 1, id: 'lock', name: 'lock', network: { kind: 'custom', id: 'lock' },
    od: [
      { origin: 'in', destination: 'out1', rateVph: 600 },
      { origin: 'in2', destination: 'out2', rateVph: 300 },
    ],
    composition: { car: 1 },
    compositionByOrigin: { in: { truck: 1 }, in2: { car: 1 } },
    mode: 'lane', durationS: 900, warmupS: 120, seed: 1,
  };

  it('a forced gridlock is flagged and meanDelayS ≫ meanDelayCompletedS', () => {
    const r = runReplicate({ scenario, classes, network: net }, 9);
    const m = manual(scenario, 9, net, classes);
    expectSame(r.metrics, m);
    expect(r.metrics.lockedJunctions).toBeGreaterThanOrEqual(1);
    expect(r.metrics.gridlocked).toBe(1);
    expect(r.metrics.completedTrips).toBeGreaterThan(10);
    // ≈ 2/3 of the window's trips are stuck trucks with delay ≈ (900 − tGen) − freeFlow, i.e. a
    // few hundred seconds; completed corridor trips have delays of seconds. "≫" as ≥ 10× and
    // ≥ 100 s apart.
    expect(r.metrics.meanDelayS).toBeGreaterThanOrEqual(10 * Math.max(1, r.metrics.meanDelayCompletedS));
    expect(r.metrics.meanDelayS - r.metrics.meanDelayCompletedS).toBeGreaterThanOrEqual(100);
  });

  it('a free-flowing run has gridlocked = 0', () => {
    const r = runReplicate({ scenario: corridor({}), classes: CLASSES }, 3);
    expect(r.metrics.gridlocked).toBe(0);
    expect(r.metrics.lockedJunctions).toBe(0);
  });
});

describe('summarize and compare', () => {
  const input = { scenario: corridor({}), classes: CLASSES };
  const base = [11, 12, 13].map((s) => runReplicate(input, s));

  it('summarize gives meanCI of each metric over the replicates', () => {
    const sum = summarize(base);
    for (const k of METRICS) {
      const xs = base.map((r) => r.metrics[k]);
      if (xs.some((x) => Number.isNaN(x))) continue;
      const ref = meanCIRef(xs);
      expect(sum[k].n).toBe(3);
      expect(Math.abs(sum[k].mean - ref.mean)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ref.mean)));
      // tQuantile accuracy 1e-6·max(1, t) (§5.1)
      expect(Math.abs(sum[k].half - ref.half)).toBeLessThanOrEqual(1e-6 * ref.half + 1e-9);
    }
  });

  it('compare(base, base) is exactly zero with zero half-width (common random numbers)', () => {
    const c = compare(base, base);
    for (const k of METRICS) {
      if (base.some((r) => Number.isNaN(r.metrics[k]))) continue;
      expect([c[k].mean, c[k].half, c[k].lo, c[k].hi], k).toEqual([0, 0, 0, 0]);
    }
  });

  it('compare(base, variant) is pairedCI of variant − base per metric', () => {
    const variant = [11, 12, 13].map((s) => runReplicate({ scenario: corridor({ rateVph: 1200 }), classes: CLASSES }, s));
    const c = compare(base, variant);
    for (const k of METRICS) {
      expect(c[k]).toEqual(pairedCI(base.map((r) => r.metrics[k]), variant.map((r) => r.metrics[k])));
    }
  });
});
