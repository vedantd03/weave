import type { MetricId } from './experiment.ts';
import type { Sim } from '../sim/sim.ts';

/** Run summary and per-segment statistics at the sim's current time (docs/MODEL.md §6.2). */

export interface SegmentStat {
  id: string;
  kind: 'link' | 'movement';
  lengthM: number;
  widthM: number;
  entered: number;
  exited: number;
  vehicleKm: number;
  vehicleHours: number;
  meanSpeedKmh: number;
  meanDensityPerKm: number;
  meanFlowVph: number;
  onNow: number;
  guardActivations: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** §5.2 metrics over the window [warmupS, t] at the sim's current time t. */
export function runSummary(sim: Sim, warmupS: number): Record<MetricId, number> {
  const dt = sim.dt;
  const D = sim.t;
  const w = warmupS;
  const stepsW = Math.round(w / dt);
  const stepsM = Math.max(stepsW, Math.floor((w + (D - w) / 2) / dt)); // window midpoint, §5.2
  const atW = sim.historyAt(stepsW);
  const inW = (t: number) => t >= w - 1e-9 && t <= D + 1e-9;
  const trips = sim.trips().filter((t) => inW(t.tGen));
  const gen = sim.generatedLog().filter((g) => inW(g.tGen));
  const rows = sim.series().filter((r) => r.t0 >= w - 1e-9 && r.t1 <= D + 1e-9);
  const d = sim.diagnostics();
  const done = new Set(trips.map((t) => t.id));
  // Unfinished trips: delay so far = time since generation − free-flow time for the distance
  // actually travelled (0 m for vehicles still in an entry queue), §5.2.
  const onNet = new Map(sim.vehicles().map((v) => [v.id, v.freeFlowTravelledS]));
  const delays = [
    ...trips.map((t) => t.tExit - t.tGen - t.freeFlowS),
    ...gen.filter((g) => !done.has(g.id)).map((g) => D - g.tGen - (onNet.get(g.id) ?? 0)),
  ];
  const locked = sim.gridlock()?.junctions.length ?? 0;
  // Queue still growing: grew by more than one minute of total demand (≥ 10 veh) over the
  // second half of the window (§5.2; threshold is an assumption).
  const lambda = sim.scenario.od.reduce((a, r) => a + r.rateVph, 0) / 3600;
  const growth = sim.counters().entryQueue - sim.queueAt(stepsM);
  return {
    meanDelayS: mean(delays),
    meanDelayCompletedS: mean(trips.map((t) => t.tExit - t.tGen - t.freeFlowS)),
    gridlocked: locked > 0 ? 1 : 0,
    queueGrowing: growth > Math.max(10, 60 * lambda) ? 1 : 0,
    meanTravelTimeS: mean(trips.map((t) => t.tExit - t.tGen)),
    throughputVph: ((sim.counters().exited - atW.exited) * 3600) / (D - w),
    meanSpeedKmh: 3.6 * mean(rows.map((r) => r.meanSpeedMps)),
    maxEntryQueue: rows.length ? Math.max(...rows.map((r) => r.entryQueue)) : NaN,
    completedTrips: trips.length,
    incompleteTrips: gen.length - trips.length,
    divertedTrips: d.diversions - atW.diversions,
    lockedJunctions: locked,
    guardPer10k: d.vehicleSteps > 0 ? (1e4 * d.guardActivations) / d.vehicleSteps : 0,
    guardPer1000VehKm: d.vehicleKm > 0 ? (1000 * d.guardActivations) / d.vehicleKm : 0,
  };
}

/** Cumulative per-segment statistics since t = 0 (links first, then movements). */
export function segmentStats(sim: Sim): SegmentStat[] {
  const net = sim.network;
  const ls = sim.linkStats();
  const dist = sim.segmentDistanceM();
  const guard = sim.diagnostics().guardBySegment;
  const onNow = new Map<string, number>();
  for (const v of sim.vehicles()) onNow.set(v.link, (onNow.get(v.link) ?? 0) + 1);
  const T = sim.t;
  const segs = [
    ...net.links.map((l) => ({ id: l.id, kind: 'link' as const, widthM: l.widthM, poly: l.polyline })),
    ...net.movements.map((m) => ({ id: m.id, kind: 'movement' as const, widthM: m.widthM, poly: m.path })),
  ];
  return segs.map((g, i) => {
    let lengthM = 0;
    for (let k = 1; k < g.poly.length; k++) lengthM += Math.hypot(g.poly[k]![0] - g.poly[k - 1]![0], g.poly[k]![1] - g.poly[k - 1]![1]);
    const st = ls[g.id]!;
    const vehicleKm = dist[i]! / 1000;
    const vehicleHours = st.vehicleSeconds / 3600;
    const area = (lengthM / 1000) * (T / 3600); // km·h
    return {
      id: g.id,
      kind: g.kind,
      lengthM,
      widthM: g.widthM,
      entered: st.entered,
      exited: st.exited,
      vehicleKm,
      vehicleHours,
      meanSpeedKmh: vehicleHours > 0 ? vehicleKm / vehicleHours : NaN,
      meanDensityPerKm: area > 0 ? vehicleHours / area : NaN,
      meanFlowVph: area > 0 ? vehicleKm / area : NaN,
      onNow: onNow.get(g.id) ?? 0,
      guardActivations: guard[g.id] ?? 0,
    };
  });
}
