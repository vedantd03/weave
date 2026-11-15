import { z } from 'zod';
import { Scenario } from './scenario.ts';

/** Experiment definitions and results (docs/MODEL.md §7). */

const Common = {
  name: z.string(),
  reps: z.number().int().min(1).max(100),
  durationS: z.number().positive(),
  warmupS: z.number().min(0),
  /** Metric ids to show; the three stability flags are always included. */
  metrics: z.array(z.string()).default([]),
};

export const ReplicateDesign = z.object({ type: z.literal('replicate'), scenario: Scenario, ...Common });
export const CompareDesign = z.object({
  type: z.literal('compare'),
  /** The first scenario is the baseline. */
  scenarios: z.array(z.object({ name: z.string(), scenario: Scenario })).min(2),
  ...Common,
});
export const SweepDesign = z.object({
  type: z.literal('sweep'),
  scenario: Scenario,
  param: z.string(),
  values: z.array(z.union([z.number(), z.string()])).min(1).max(10),
  ...Common,
});
export const ExperimentDesign = z.discriminatedUnion('type', [ReplicateDesign, CompareDesign, SweepDesign]);
export type ExperimentDesign = z.infer<typeof ExperimentDesign>;
/** A design as the app builds it (scenario inputs, before schema defaults are applied). */
export type ExperimentDesignInput = z.input<typeof ExperimentDesign>;

export const ExperimentRun = z.object({
  /** Index of the Compare scenario or Sweep point (0 for Replicate). */
  group: z.number().int().min(0),
  seed: z.number().int(),
  metrics: z.record(z.string(), z.number().nullable()),
  breakdown: z.unknown().optional(),
});
export type ExperimentRun = z.infer<typeof ExperimentRun>;

export const ExperimentFile = z.object({
  kind: z.literal('weave-experiment'),
  version: z.literal(1),
  name: z.string(),
  createdAt: z.iso.datetime(),
  design: ExperimentDesign,
  results: z.object({ runs: z.array(ExperimentRun) }).optional(),
});
export type ExperimentFile = z.infer<typeof ExperimentFile>;
export type ExperimentFileInput = z.input<typeof ExperimentFile>;
