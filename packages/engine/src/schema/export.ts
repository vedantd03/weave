import { z } from 'zod';
import { Scenario } from './scenario.ts';

/** Run export (docs/MODEL.md §6.4). Numbers that can be NaN are exported as null. */

const num = z.number();
const nnum = z.number().nullable();

export const RunManifest = z.object({
  buildSha: z.string(),
  engineVersion: z.string(),
  schemaVersion: z.number().int(),
  /** SHA-256 (hex) of JSON.stringify(classes) as sent to the worker. */
  classesHash: z.string().regex(/^[0-9a-f]{64}$/),
  seed: z.number().int(),
  simulatedTimeS: num,
  steps: z.number().int().min(0),
  /** Deterministic state hash after `steps` steps (8 hex digits). */
  finalStateHash: z.string().regex(/^[0-9a-f]{8}$/),
  exportedAt: z.iso.datetime(),
});
export type RunManifest = z.infer<typeof RunManifest>;

export const SeriesRowExport = z.object({
  t0: num,
  t1: num,
  generated: num,
  inserted: num,
  exited: num,
  exitFlowVph: num,
  meanSpeedMps: nnum,
  densityPerKm: nnum,
  entryQueue: num,
  onNetwork: num,
});

export const SegmentStatExport = z.object({
  id: z.string(),
  kind: z.enum(['link', 'movement']),
  lengthM: num,
  widthM: num,
  entered: num,
  exited: num,
  vehicleKm: num,
  vehicleHours: num,
  meanSpeedKmh: nnum,
  meanDensityPerKm: nnum,
  meanFlowVph: nnum,
  onNow: num,
  guardActivations: num,
});

export const TripExport = z.object({
  id: z.number().int(),
  origin: z.string(),
  destination: z.string(),
  classId: z.string(),
  tGen: num,
  tInsert: nnum,
  tExit: nnum,
  freeFlowS: num,
  delayS: num,
  diverted: z.boolean(),
  unfinished: z.boolean(),
});
export type TripExport = z.infer<typeof TripExport>;

/** Field order of the trips CSV (§6.3 item 6). */
export const TRIP_FIELDS = Object.keys(TripExport.shape) as (keyof TripExport)[];
/** Field order of the series CSV. */
export const SERIES_FIELDS = Object.keys(SeriesRowExport.shape);

export const RunDiagnostics = z.object({
  guardActivations: num,
  vehicleKm: num,
  guardPer1000VehKm: num,
  guardBySegment: z.record(z.string(), num),
  lockedJunctions: z.array(z.object({ node: z.string(), sinceS: num })),
  reroutes: num,
  diversions: num,
});

/** Everything the worker can compute from the sim (§6.4 exportBody). */
export const RunExportBody = z.object({
  manifest: RunManifest.pick({ seed: true, simulatedTimeS: true, steps: true, finalStateHash: true }),
  metrics: z.record(z.string(), nnum),
  series: z.array(SeriesRowExport),
  links: z.array(SegmentStatExport),
  trips: z.array(TripExport),
  diagnostics: RunDiagnostics,
});
export type RunExportBody = z.infer<typeof RunExportBody>;

export const RunExport = z.object({
  manifest: RunManifest,
  scenario: Scenario,
  metrics: z.record(z.string(), nnum),
  series: z.array(SeriesRowExport),
  links: z.array(SegmentStatExport),
  trips: z.array(TripExport),
  diagnostics: RunDiagnostics,
});
export type RunExport = z.infer<typeof RunExport>;
