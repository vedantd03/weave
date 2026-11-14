import { z } from 'zod';
import { Dist, Param } from './common.ts';

/** Vehicle classes of the Chennai mixed-traffic dataset (codes 1..6 in the source files). */
export const VehicleClassId = z.enum(['motorcycle', 'car', 'bus', 'truck', 'lcv', 'auto']);
export type VehicleClassId = z.infer<typeof VehicleClassId>;

export const VEHICLE_CLASS_IDS = VehicleClassId.options;

export const VehicleClass = z.object({
  id: VehicleClassId,
  label: z.string(),
  lengthM: Dist,
  widthM: Dist,
  idm: z.object({
    /** Desired speed (m/s). */
    v0: Param,
    /** Desired time headway (s). */
    T: Param,
    /** Minimum standstill gap (m). */
    s0: Param,
    /** Maximum acceleration (m/s²). */
    a: Param,
    /** Comfortable deceleration (m/s², positive). */
    b: Param,
  }),
  /** Lateral clearance added on EACH side of the body: c(v) = c0 + c1 * v. */
  clearance: z.object({ c0: Param, c1: Param }),
  /** Gap acceptance at priority conflicts. */
  gap: z.object({ criticalS: Param, followUpS: Param }),
  lateral: z.object({
    /** Maximum lateral speed (m/s). */
    maxSpeedMps: Param,
    /** MOBIL politeness factor. */
    politeness: Param,
    /** MOBIL switching threshold (m/s²). */
    thresholdMps2: Param,
  }),
  /** Share in the source traffic composition (0..1). */
  share: Param,
});
export type VehicleClass = z.infer<typeof VehicleClass>;

export const ClassSet = z
  .object({
    version: z.literal(1),
    source: z.string(),
    classes: z.array(VehicleClass).min(1),
  })
  .superRefine((set, ctx) => {
    const ids = new Set<string>();
    for (const c of set.classes) {
      if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate class ${c.id}` });
      ids.add(c.id);
    }
  });
export type ClassSet = z.infer<typeof ClassSet>;
