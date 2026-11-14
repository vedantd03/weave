import { createSim, type SimInput } from '../sim/sim.ts';
import { meanCI, pairedCI, type CI } from './ci.ts';

/** Replicate metrics and multi-seed summaries (docs/MODEL.md §5.2). */

export type MetricId =
  | 'meanDelayS'
  | 'meanDelayCompletedS'
  | 'gridlocked'
  | 'meanTravelTimeS'
  | 'throughputVph'
  | 'meanSpeedKmh'
  | 'maxEntryQueue'
  | 'completedTrips'
  | 'incompleteTrips'
  | 'lockedJunctions'
  | 'guardPer10k';

export const METRICS: readonly MetricId[] = [
  'meanDelayS',
  'meanDelayCompletedS',
  'gridlocked',
  'meanTravelTimeS',
  'throughputVph',
  'meanSpeedKmh',
  'maxEntryQueue',
  'completedTrips',
  'incompleteTrips',
  'lockedJunctions',
  'guardPer10k',
];

export const METRIC_LABELS: Record<MetricId, { label: string; unit: string }> = {
  meanDelayS: { label: 'Mean delay, all trips (unfinished to end of run)', unit: 's' },
  meanDelayCompletedS: { label: 'Mean delay, completed trips only', unit: 's' },
  gridlocked: { label: 'Gridlocked (1 = locked junction at end)', unit: '' },
  meanTravelTimeS: { label: 'Mean travel time', unit: 's' },
  throughputVph: { label: 'Throughput', unit: 'veh/h' },
  meanSpeedKmh: { label: 'Mean speed', unit: 'km/h' },
  maxEntryQueue: { label: 'Max entry queue', unit: 'veh' },
  completedTrips: { label: 'Completed trips', unit: '' },
  incompleteTrips: { label: 'Incomplete trips', unit: '' },
  lockedJunctions: { label: 'Locked junctions', unit: '' },
  guardPer10k: { label: 'Collision guard', unit: 'per 10k veh-steps' },
};

export interface ReplicateResult {
  seed: number;
  metrics: Record<MetricId, number>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function runReplicate(input: SimInput, seed: number): ReplicateResult {
  const sim = createSim({ ...input, scenario: { ...input.scenario, seed } });
  const dt = sim.dt;
  const D = input.scenario.durationS;
  const w = input.scenario.warmupS ?? 300;
  sim.advance(Math.round(w / dt));
  const exitedAtW = sim.counters().exited;
  sim.advance(Math.round(D / dt) - Math.round(w / dt));
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
  return {
    seed,
    metrics: {
      meanDelayS: mean(delays),
      meanDelayCompletedS: mean(trips.map((t) => t.tExit - t.tGen - t.freeFlowS)),
      gridlocked: locked > 0 ? 1 : 0,
      meanTravelTimeS: mean(trips.map((t) => t.tExit - t.tGen)),
      throughputVph: ((sim.counters().exited - exitedAtW) * 3600) / (D - w),
      meanSpeedKmh: 3.6 * mean(rows.map((r) => r.meanSpeedMps)),
      maxEntryQueue: rows.length ? Math.max(...rows.map((r) => r.entryQueue)) : NaN,
      completedTrips: trips.length,
      incompleteTrips: gen.length - trips.length,
      lockedJunctions: locked,
      guardPer10k: d.vehicleSteps > 0 ? (1e4 * d.guardActivations) / d.vehicleSteps : 0,
    },
  };
}

export function summarize(results: ReplicateResult[], level = 0.95): Record<MetricId, CI> {
  const out = {} as Record<MetricId, CI>;
  for (const m of METRICS) out[m] = meanCI(results.map((r) => r.metrics[m]), level);
  return out;
}

export function compare(base: ReplicateResult[], variant: ReplicateResult[], level = 0.95): Record<MetricId, CI> {
  const out = {} as Record<MetricId, CI>;
  for (const m of METRICS) out[m] = pairedCI(base.map((r) => r.metrics[m]), variant.map((r) => r.metrics[m]), level);
  return out;
}
