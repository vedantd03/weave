import { z } from 'zod';
import { ClassSet } from './schema/classes.ts';
import { Network } from './schema/network.ts';
import { Scenario } from './schema/scenario.ts';

/**
 * Worker protocol. Main → worker messages are zod-validated in the worker. Worker → main frames
 * carry a transferable Float32Array; their envelope is validated on the main thread.
 */

/**
 * Per-vehicle record layout in a frame buffer. (x, y) is the body CENTRE in world metres;
 * heading is radians counter-clockwise from +x; class is the index into the ClassSet.
 */
export const FRAME_STRIDE = 7;
export const F_X = 0;
export const F_Y = 1;
export const F_HEADING = 2;
export const F_CLASS = 3;
/** Vehicle length varies within a class (e.g. cars ±0.6 m): never look up a class constant. */
export const F_LENGTH = 4;
export const F_WIDTH = 5;
export const F_LAYER = 6;

/* ---------- main → worker ---------- */

export const InitMsg = z.object({
  type: z.literal('init'),
  scenario: Scenario,
  /** Required when scenario.network.kind === 'file' (main thread fetches the JSON). */
  network: Network.optional(),
  classes: ClassSet,
});
export const PlayMsg = z.object({ type: z.literal('play') });
export const PauseMsg = z.object({ type: z.literal('pause') });
export const StepMsg = z.object({ type: z.literal('step'), steps: z.number().int().min(1).max(100_000) });
/** Simulated seconds per wall-clock second while playing. */
export const SpeedMsg = z.object({ type: z.literal('setSpeed'), factor: z.number().min(0.1).max(1000) });
export const ResetMsg = z.object({ type: z.literal('reset') });
export const PingMsg = z.object({ type: z.literal('ping'), nonce: z.number() });

export const ToWorker = z.discriminatedUnion('type', [
  InitMsg,
  PlayMsg,
  PauseMsg,
  StepMsg,
  SpeedMsg,
  ResetMsg,
  PingMsg,
]);
export type ToWorker = z.infer<typeof ToWorker>;
export type ToWorkerInput = z.input<typeof ToWorker>;

/* ---------- worker → main ---------- */

export const MetricsDelta = z.object({
  /** Simulated time at the end of the aggregation window (s). */
  t: z.number(),
  vehiclesOnNetwork: z.number().int().min(0),
  entryQueue: z.number().int().min(0),
  generated: z.number().int().min(0),
  exited: z.number().int().min(0),
  meanSpeedMps: z.number().min(0),
  /** Collision-guard activations and vehicle-steps so far (ADR-015). */
  guardActivations: z.number().int().min(0).default(0),
  vehicleSteps: z.number().int().min(0).default(0),
  /** Why vehicles were held at junctions (counts), MODEL.md §3.4. */
  holds: z.record(z.string(), z.number()).default({}),
  /** Gridlock report (§3.4 item 6) or null. */
  gridlock: z
    .object({ detected: z.boolean(), sinceS: z.number(), junctions: z.array(z.object({ node: z.string(), sinceS: z.number() })) })
    .nullable()
    .default(null),
});
export type MetricsDelta = z.infer<typeof MetricsDelta>;

export const ReadyMsg = z.object({
  type: z.literal('ready'),
  /** The fully built network (generated or loaded), for rendering. */
  network: Network,
  stateHash: z.string(),
});
export const FrameMsg = z.object({
  type: z.literal('frame'),
  t: z.number(),
  step: z.number().int().min(0),
  count: z.number().int().min(0),
  data: z.instanceof(Float32Array),
  /** Signal colour per movement index: 0 red, 1 amber, 2 green, 3 permissive green, 255 uncontrolled. */
  signals: z.instanceof(Uint8Array),
  stateHash: z.string(),
  metrics: MetricsDelta.optional(),
});
export const SeriesRowSchema = z.object({
  t0: z.number(),
  t1: z.number(),
  generated: z.number(),
  inserted: z.number(),
  exited: z.number(),
  exitFlowVph: z.number(),
  meanSpeedMps: z.number(),
  densityPerKm: z.number(),
  entryQueue: z.number(),
  onNetwork: z.number(),
  lockedJunctions: z.number().default(0),
});
/** Completed 60 s aggregation windows, appended in order (MODEL.md §2.7). */
export const SeriesMsg = z.object({ type: z.literal('series'), fromIndex: z.number().int().min(0), rows: z.array(SeriesRowSchema) });
export const PongMsg = z.object({ type: z.literal('pong'), nonce: z.number() });
export const ErrorMsg = z.object({ type: z.literal('error'), message: z.string() });

export const FromWorker = z.discriminatedUnion('type', [ReadyMsg, FrameMsg, SeriesMsg, PongMsg, ErrorMsg]);
export type FromWorker = z.infer<typeof FromWorker>;
export type FrameMsg = z.infer<typeof FrameMsg>;
