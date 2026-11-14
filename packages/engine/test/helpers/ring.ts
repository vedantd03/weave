/**
 * Builders for single-class ring-road scenarios through the public contract (zod schemas).
 * Only schema code is imported here, never engine internals.
 */
import { ClassSet, type ScenarioInput } from '../../src/schema/index.ts';
import type { Idm } from './idm-theory.ts';

const p = (value: number) => ({ value, provenance: 'assumption' as const, note: 'test', spread: 0 });
const fixed = (value: number) => ({ kind: 'fixed' as const, value, provenance: 'assumption' as const, note: 'test' });

/** Road width used by every ring test (MODEL.md: widthM 3.5, one lane). */
export const RING_WIDTH_M = 3.5;

/**
 * Body width 2.9 m plus clearance 0.3 m on each side = 3.5 m = the whole carriageway. Every
 * vehicle therefore occupies all strips, so the ring is a strict single file in strip mode and
 * the M2 lateral model (once it lands) has no lateral room to change these tests' physics.
 */
export const RING_BODY_WIDTH_M = 2.9;
export const RING_CLEARANCE_M = 0.3;

/** One class ('car'), fixed size, spread 0 on every parameter (all drivers identical). */
export function ringClassSet(idm: Idm, lengthM: number): ClassSet {
  return ClassSet.parse({
    version: 1,
    source: 'test: single-class ring',
    classes: [
      {
        id: 'car',
        label: 'Test car',
        lengthM: fixed(lengthM),
        widthM: fixed(RING_BODY_WIDTH_M),
        idm: { v0: p(idm.v0), T: p(idm.T), s0: p(idm.s0), a: p(idm.a), b: p(idm.b) },
        clearance: { c0: p(RING_CLEARANCE_M), c1: p(0) },
        gap: { criticalS: p(4), followUpS: p(2.5) },
        lateral: { maxSpeedMps: p(0.8), politeness: p(0.2), thresholdMps2: p(0.1) },
        share: p(1),
      },
    ],
  });
}

export interface RingOpts {
  circumferenceM: number;
  densityPerKm: number;
  jitterM: number;
  seed: number;
  dtS?: number;
}

/**
 * Ring scenario. speedLimitMps is set to 40 m/s, above every v0 used in the tests, so that a
 * speed-limit cap (not part of MODEL.md §1.3) could never bind.
 */
export function ringScenario(o: RingOpts): ScenarioInput {
  return {
    version: 1,
    id: 'test-ring',
    name: 'test ring',
    network: {
      kind: 'generator',
      params: { generator: 'ring', circumferenceM: o.circumferenceM, widthM: RING_WIDTH_M, lanes: 1, speedLimitMps: 40 },
    },
    composition: { car: 1 },
    initialDensityPerKm: o.densityPerKm,
    initialJitterM: o.jitterM,
    mode: 'strip',
    dtS: o.dtS ?? 0.2,
    durationS: 4 * 3600,
    warmupS: 0,
    seed: o.seed,
  };
}

/** Vehicle count on a link of length L (MODEL.md §1.7): round(density · L / 1000). */
export function ringCount(densityPerKm: number, circumferenceM: number): number {
  return Math.round((densityPerKm * circumferenceM) / 1000);
}
