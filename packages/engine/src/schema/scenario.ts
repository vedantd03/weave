import { z } from 'zod';
import { Id } from './common.ts';
import { VehicleClassId } from './classes.ts';
import { SignalPlan } from './network.ts';

/* ---------- Parametric network generators (no geometry drawing) ---------- */

export const RingParams = z.object({
  generator: z.literal('ring'),
  circumferenceM: z.number().min(100).max(10_000),
  widthM: z.number().min(2).max(25),
  lanes: z.number().int().min(1).max(6).default(1),
  speedLimitMps: z.number().positive().default(22.2),
});

export const CorridorParams = z.object({
  generator: z.literal('corridor'),
  lengthM: z.number().min(100).max(5_000),
  widthM: z.number().min(2).max(25),
  lanes: z.number().int().min(1).max(6),
  speedLimitMps: z.number().positive().default(16.7),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({
      kind: z.literal('width'),
      atM: z.number().min(0),
      toWidthM: z.number().min(2).max(25),
      toLanes: z.number().int().min(1).max(6),
      taperM: z.number().min(0).max(200).default(30),
    }),
    z.object({
      kind: z.literal('laneDrop'),
      atM: z.number().min(0),
      dropLanes: z.number().int().min(1).max(5),
      taperM: z.number().min(0).max(200).default(50),
    }),
  ]),
}).superRefine((p, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (p.change.kind !== 'none' && p.change.atM + p.change.taperM >= p.lengthM) {
    bad('change position + taper must be inside the corridor');
  }
  if (p.change.kind === 'laneDrop' && p.change.dropLanes >= p.lanes) bad('cannot drop every lane');
});

export const ArmParams = z.object({
  angleDeg: z.number().min(0).lt(360),
  inWidthM: z.number().min(3).max(21),
  outWidthM: z.number().min(3).max(21),
  inLanes: z.number().int().min(1).max(6),
  outLanes: z.number().int().min(1).max(6),
  lengthM: z.number().min(50).max(1_000).default(250),
});

export const FlyoverParams = z.object({
  enabled: z.boolean(),
  /** Indices of the two arms joined by the elevated through road. */
  armA: z.number().int().min(0),
  armB: z.number().int().min(0),
  deckWidthM: z.number().min(3).max(14),
  rampWidthM: z.number().min(3).max(14),
  landingWidthM: z.number().min(3).max(21),
  rampLengthM: z.number().min(40).max(400),
  heightM: z.number().min(4).max(12).default(6.5),
});

export const JunctionParams = z
  .object({
    generator: z.literal('junction'),
    arms: z.array(ArmParams).min(3).max(6),
    control: z.enum(['signal', 'priority']),
    /** For priority control: the two arms forming the major road. */
    majorArms: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    speedLimitMps: z.number().positive().default(13.9),
    flyover: FlyoverParams.optional(),
  })
  .superRefine((p, ctx) => {
    const n = p.arms.length;
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (p.flyover?.enabled) {
      const { armA, armB, rampLengthM } = p.flyover;
      if (armA >= n || armB >= n || armA === armB) bad('flyover arms must be two distinct arms');
      for (const k of [armA, armB]) {
        const arm = p.arms[k];
        if (arm && arm.lengthM < rampLengthM + 30) bad(`arm ${k + 1} must be at least ramp length + 30 m long for the flyover`);
      }
    }
    if (p.majorArms) {
      const [a, b] = p.majorArms;
      if (a >= n || b >= n || a === b) bad('majorArms must be two distinct arms');
    }
    if (p.control === 'priority' && !p.majorArms) bad('priority control needs majorArms');
  });

export const MergeParams = z.object({
  generator: z.literal('merge'),
  mainWidthM: z.number().min(3).max(21),
  mainLanes: z.number().int().min(1).max(6),
  rampWidthM: z.number().min(3).max(10),
  taperM: z.number().min(30).max(400),
  mainLengthM: z.number().min(200).max(3_000),
  rampLengthM: z.number().min(50).max(1_000),
  angleDeg: z.number().min(5).max(45).default(15),
  speedLimitMps: z.number().positive().default(16.7),
});

export const GeneratorParams = z.union([RingParams, CorridorParams, JunctionParams, MergeParams]);
export type GeneratorParams = z.infer<typeof GeneratorParams>;
export type RingParams = z.infer<typeof RingParams>;
export type CorridorParams = z.infer<typeof CorridorParams>;
export type JunctionParams = z.infer<typeof JunctionParams>;
export type MergeParams = z.infer<typeof MergeParams>;

export const NetworkSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generator'), params: GeneratorParams }),
  z.object({ kind: z.literal('file'), id: z.enum(['silkboard']) }),
  /** A network supplied directly to createSim (tests, imported files). */
  z.object({ kind: z.literal('custom'), id: Id }),
]);
export type NetworkSource = z.infer<typeof NetworkSource>;

/* ---------- Scenario ---------- */

export const OdEntry = z.object({
  origin: Id,
  destination: Id,
  rateVph: z.number().min(0).max(20_000),
});
export type OdEntry = z.infer<typeof OdEntry>;

export const Composition = z
  .partialRecord(VehicleClassId, z.number().min(0))
  .refine((c) => Object.values(c).some((v) => v > 0), { message: 'composition needs a positive share' });
export type Composition = z.infer<typeof Composition>;

export const Scenario = z.object({
  version: z.literal(1),
  id: Id,
  name: z.string(),
  /** One line on what the scenario shows (revision 4, shown in the app). */
  description: z.string().optional(),
  network: NetworkSource,
  /** Origin–destination demand over zone IDs. Destination and route are fixed at generation. */
  od: z.array(OdEntry).default([]),
  /** Class shares (normalised by the engine). Per-origin overrides are optional. */
  composition: Composition,
  compositionByOrigin: z.record(Id, Composition).optional(),
  /** Vehicles placed evenly on every link at t = 0 (used by ring and corridor tests). */
  initialDensityPerKm: z.number().min(0).max(400).default(0),
  /** Uniform jitter (±m) of initial positions, drawn from the 'init' substream (breaks symmetry). */
  initialJitterM: z.number().min(0).max(10).default(0),
  /** Replace generated/imported signal plans for these nodes. */
  signalOverrides: z.array(SignalPlan).default([]),
  mode: z.enum(['strip', 'lane']).default('strip'),
  stripWidthM: z.number().min(0.1).max(1).default(0.25),
  /** Time step: 0.1, 0.2 or 0.25 s (MODEL.md §5.2 revision 4; 0.5 s broke the dt-error bounds). */
  dtS: z.union([z.literal(0.1), z.literal(0.2), z.literal(0.25)]).default(0.2),
  durationS: z.number().positive().max(4 * 3600),
  warmupS: z.number().min(0).default(300),
  /** Probability a driver respects "don't block the box" (1 = always). */
  boxCompliance: z.number().min(0).max(1).default(1),
  seed: z.number().int().min(0).max(0xffffffff),
  replications: z.number().int().min(1).max(100).default(10),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;
