import type { Sim } from '../sim/sim.ts';
import type { RunExportBody, TripExport } from '../schema/export.ts';
import { runSummary, segmentStats } from './summary.ts';

/** Run export pieces computed from the sim (docs/MODEL.md §6.4). */

const nn = (x: number): number | null => (Number.isFinite(x) ? x : null);

/** One record per generated vehicle since t = 0, in id order. */
export function tripRecords(sim: Sim): TripExport[] {
  const t = sim.t;
  const done = new Map(sim.trips().map((r) => [r.id, r]));
  const onNet = new Map(sim.vehicles().map((v) => [v.id, v]));
  return sim
    .generatedLog()
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((g) => {
      const base = { id: g.id, origin: g.origin, destination: g.destination, classId: g.classId, tGen: g.tGen, freeFlowS: g.freeFlowS };
      const c = done.get(g.id);
      if (c) return { ...base, tInsert: c.tInsert, tExit: c.tExit, delayS: c.tExit - c.tGen - c.freeFlowS, diverted: c.diverted, unfinished: false };
      const v = onNet.get(g.id);
      if (v) return { ...base, tInsert: v.tInsert, tExit: null, delayS: t - g.tGen - v.freeFlowTravelledS, diverted: v.diverted, unfinished: true };
      return { ...base, tInsert: null, tExit: null, delayS: t - g.tGen, diverted: false, unfinished: true };
    });
}

/** Everything in a RunExport except buildSha, engineVersion, classesHash, exportedAt and scenario. */
export function exportBody(sim: Sim): RunExportBody {
  const warmup = sim.scenario.warmupS ?? 300;
  const metrics = Object.fromEntries(Object.entries(runSummary(sim, warmup)).map(([k, v]) => [k, nn(v)]));
  const d = sim.diagnostics();
  const g = sim.gridlock();
  return {
    manifest: { seed: sim.scenario.seed, simulatedTimeS: sim.t, steps: sim.step, finalStateHash: sim.stateHash() },
    metrics,
    series: sim.series().map((r) => ({ ...r, meanSpeedMps: nn(r.meanSpeedMps), densityPerKm: nn(r.densityPerKm) })),
    links: segmentStats(sim).map((l) => ({ ...l, meanSpeedKmh: nn(l.meanSpeedKmh), meanDensityPerKm: nn(l.meanDensityPerKm), meanFlowVph: nn(l.meanFlowVph) })),
    trips: tripRecords(sim),
    diagnostics: {
      guardActivations: d.guardActivations,
      vehicleKm: d.vehicleKm,
      guardPer1000VehKm: d.vehicleKm > 0 ? (1000 * d.guardActivations) / d.vehicleKm : 0,
      guardBySegment: d.guardBySegment,
      lockedJunctions: (g?.junctions ?? []).map((j) => ({ node: j.node, sinceS: j.sinceS })),
      reroutes: d.reroutes,
      diversions: d.diversions,
    },
  };
}
