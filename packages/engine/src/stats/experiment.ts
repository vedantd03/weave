import { createSim, type SimInput } from '../sim/sim.ts';
import { meanCI, pairedCI, type CI } from './ci.ts';
import { runSummary } from './summary.ts';

/** Replicate metrics and multi-seed summaries (docs/MODEL.md §5.2). */

export type MetricId =
  | 'meanDelayS'
  | 'meanDelayCompletedS'
  | 'gridlocked'
  | 'queueGrowing'
  | 'meanTravelTimeS'
  | 'throughputVph'
  | 'meanSpeedKmh'
  | 'maxEntryQueue'
  | 'completedTrips'
  | 'incompleteTrips'
  | 'divertedTrips'
  | 'lockedJunctions'
  | 'guardPer10k'
  | 'guardPer1000VehKm';

export const METRICS: readonly MetricId[] = [
  'meanDelayS',
  'meanDelayCompletedS',
  'gridlocked',
  'queueGrowing',
  'meanTravelTimeS',
  'throughputVph',
  'meanSpeedKmh',
  'maxEntryQueue',
  'completedTrips',
  'incompleteTrips',
  'divertedTrips',
  'lockedJunctions',
  'guardPer10k',
  'guardPer1000VehKm',
];

export const METRIC_LABELS: Record<MetricId, { label: string; unit: string }> = {
  meanDelayS: { label: 'Mean delay, all trips (unfinished to end of run)', unit: 's' },
  meanDelayCompletedS: { label: 'Mean delay, completed trips only', unit: 's' },
  gridlocked: { label: 'Gridlocked (1 = locked junction at end)', unit: '' },
  queueGrowing: { label: 'Entry queue still growing (1 = yes)', unit: '' },
  meanTravelTimeS: { label: 'Mean travel time', unit: 's' },
  throughputVph: { label: 'Throughput', unit: 'veh/h' },
  meanSpeedKmh: { label: 'Mean speed', unit: 'km/h' },
  maxEntryQueue: { label: 'Max entry queue', unit: 'veh' },
  completedTrips: { label: 'Completed trips', unit: '' },
  incompleteTrips: { label: 'Incomplete trips', unit: '' },
  divertedTrips: { label: 'Diverted trips', unit: '' },
  lockedJunctions: { label: 'Locked junctions', unit: '' },
  guardPer10k: { label: 'Collision guard', unit: 'per 10k veh-steps' },
  guardPer1000VehKm: { label: 'Collision guard', unit: 'per 1,000 veh-km' },
};

export interface ReplicateResult {
  seed: number;
  metrics: Record<MetricId, number>;
}

export function runReplicate(input: SimInput, seed: number): ReplicateResult {
  const sim = createSim({ ...input, scenario: { ...input.scenario, seed } });
  sim.advance(Math.round(input.scenario.durationS / sim.dt));
  return { seed, metrics: runSummary(sim, input.scenario.warmupS ?? 300) };
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
