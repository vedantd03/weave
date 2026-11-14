/**
 * M2 test scaffolding: structural types for the M2 Sim API exactly as listed in
 * docs/MODEL.md §1.7/§2.7, scenario and class builders through the zod contract, and small
 * observation utilities. No engine internals are imported except createSim (the API under test).
 */
import { createSim } from '../../src/sim/sim.ts';
import { ClassSet, type Network, type ScenarioInput, type VehicleClassId } from '../../src/schema/index.ts';
import type { Idm } from './idm-theory.ts';

/* ---------- M2 API as specified (MODEL.md §1.7, §2.7) ---------- */

export interface VView {
  id: number;
  classId: VehicleClassId;
  link: string;
  s: number;
  y: number;
  v: number;
  a: number;
  length: number;
  width: number;
  lo: number;
  hi: number;
  targetY: number;
}
export interface Counters {
  generated: number;
  exited: number;
  onNetwork: number;
  entryQueue: number;
}
export interface LinkStat {
  entered: number;
  exited: number;
  vehicleSeconds: number;
  travelTimeSum: number;
  travelTimeCount: number;
}
export interface Trip {
  id: number;
  origin: string;
  destination: string;
  classId: VehicleClassId;
  tGen: number;
  tInsert: number;
  tExit: number;
  freeFlowS: number;
}
export interface GenRecord {
  id: number;
  origin: string;
  destination: string;
  classId: VehicleClassId;
  tGen: number;
  length: number;
  width: number;
  v0: number;
  T: number;
  s0: number;
  a: number;
  b: number;
  /** route free-flow time, computed as in trips() (§2.7) */
  freeFlowS: number;
}
export interface SeriesRow {
  t0: number;
  t1: number;
  generated: number;
  inserted: number;
  exited: number;
  exitFlowVph: number;
  meanSpeedMps: number;
  densityPerKm: number;
  entryQueue: number;
  onNetwork: number;
}
export interface AddSpec {
  classId: VehicleClassId;
  link: string;
  s: number;
  y: number;
  v: number;
}
export interface M2Sim {
  readonly t: number;
  readonly step: number;
  readonly dt: number;
  readonly network: Network;
  advance(steps?: number): void;
  vehicles(): VView[];
  vehicleCount(): number;
  stateHash(): string;
  counters(): Counters;
  addVehicle(spec: AddSpec): number;
  linkStats(): unknown;
  trips(): Trip[];
  generatedLog(): GenRecord[];
  series(): SeriesRow[];
}

/** createSim typed against the M2 API listed in the spec. */
export function makeSim(scenario: ScenarioInput, classes: ClassSet, network?: Network): M2Sim {
  const input = network ? { scenario, classes, network } : { scenario, classes };
  return createSim(input as Parameters<typeof createSim>[0]) as unknown as M2Sim;
}

/**
 * linkStats() is "cumulative per segment" (§2.7); the container shape is not pinned by the spec,
 * so accept either a record keyed by segment id or an array of rows carrying the id.
 */
export function linkStat(sim: M2Sim, segment: string): LinkStat {
  const ls = sim.linkStats() as unknown;
  let row: unknown;
  if (Array.isArray(ls)) {
    row = (ls as Record<string, unknown>[]).find((r) => r.id === segment || r.segment === segment || r.link === segment);
  } else if (ls instanceof Map) {
    row = (ls as Map<string, unknown>).get(segment);
  } else if (ls && typeof ls === 'object') {
    row = (ls as Record<string, unknown>)[segment];
  }
  if (!row) throw new Error(`linkStats(): no row for segment ${segment}`);
  return row as LinkStat;
}

/* ---------- builders ---------- */

const p = (value: number) => ({ value, provenance: 'assumption' as const, note: 'test', spread: 0 });
const fixed = (value: number) => ({ kind: 'fixed' as const, value, provenance: 'assumption' as const, note: 'test' });

export interface ClassSpec {
  id: VehicleClassId;
  length: number;
  width: number;
  idm: Idm;
  c0?: number;
  c1?: number;
  maxLat?: number;
  politeness?: number;
  threshold?: number;
}

export interface ClassParams {
  length: number;
  width: number;
  idm: Idm;
  c0: number;
  c1: number;
  maxLat: number;
  p: number;
  th: number;
}

export function classParams(s: ClassSpec): ClassParams {
  return {
    length: s.length,
    width: s.width,
    idm: s.idm,
    c0: s.c0 ?? 0.2,
    c1: s.c1 ?? 0,
    maxLat: s.maxLat ?? 0.8,
    p: s.politeness ?? 0,
    th: s.threshold ?? 0.1,
  };
}

/** A ClassSet with every spread 0 (all drivers of a class identical). */
export function classSet(specs: ClassSpec[]): ClassSet {
  return ClassSet.parse({
    version: 1,
    source: 'test',
    classes: specs.map((s) => {
      const c = classParams(s);
      return {
        id: s.id,
        label: s.id,
        lengthM: fixed(c.length),
        widthM: fixed(c.width),
        idm: { v0: p(c.idm.v0), T: p(c.idm.T), s0: p(c.idm.s0), a: p(c.idm.a), b: p(c.idm.b) },
        clearance: { c0: p(c.c0), c1: p(c.c1) },
        gap: { criticalS: p(4), followUpS: p(2.5) },
        lateral: { maxSpeedMps: p(c.maxLat), politeness: p(c.p), thresholdMps2: p(c.th) },
        share: p(1),
      };
    }),
  });
}

export type Change =
  | { kind: 'none' }
  | { kind: 'width'; atM: number; toWidthM: number; toLanes: number; taperM?: number }
  | { kind: 'laneDrop'; atM: number; dropLanes: number; taperM?: number };

export interface CorridorOpts {
  lengthM: number;
  widthM: number;
  lanes: number;
  change?: Change;
  speedLimitMps?: number;
  rateVph?: number;
  mode?: 'strip' | 'lane';
  seed?: number;
  composition?: Partial<Record<VehicleClassId, number>>;
  initialDensityPerKm?: number;
  stripWidthM?: number;
  dtS?: number;
}

/**
 * Corridor scenario (§2.6). speedLimitMps defaults to 40 m/s, above every v0 used, so the
 * speed-limit cap of §1.3 never binds unless a test asks for it.
 */
export function corridorScenario(o: CorridorOpts): ScenarioInput {
  return {
    version: 1,
    id: 'test-corridor',
    name: 'test corridor',
    network: {
      kind: 'generator',
      params: {
        generator: 'corridor',
        lengthM: o.lengthM,
        widthM: o.widthM,
        lanes: o.lanes,
        speedLimitMps: o.speedLimitMps ?? 40,
        change: o.change ?? { kind: 'none' },
      },
    },
    od: o.rateVph ? [{ origin: 'in', destination: 'out', rateVph: o.rateVph }] : [],
    composition: o.composition ?? { car: 1 },
    initialDensityPerKm: o.initialDensityPerKm ?? 0,
    initialJitterM: 0,
    mode: o.mode ?? 'strip',
    stripWidthM: o.stripWidthM ?? 0.3,
    dtS: o.dtS ?? 0.2,
    durationS: 4 * 3600,
    warmupS: 0,
    seed: o.seed ?? 1,
  };
}

/** Polyline length (m). */
export function polyLength(pl: readonly (readonly [number, number])[] | readonly number[][]): number {
  let L = 0;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1]!;
    const b = pl[i]!;
    L += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
  }
  return L;
}

/** Student-t upper 0.9995 quantile for small df (two-sided 0.001), standard tables. */
export const T_9995: Record<number, number> = {
  5: 6.869, 9: 4.781, 10: 4.587, 14: 4.140, 15: 4.073, 19: 3.883, 20: 3.850, 24: 3.745, 29: 3.659,
};
