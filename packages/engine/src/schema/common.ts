import { z } from 'zod';

/** All quantities are SI: metres, seconds, m/s, m/s². Field names carry a unit suffix. */

export const Id = z.string().min(1);

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

export const Polyline = z.array(Vec2).min(2);
export type Polyline = z.infer<typeof Polyline>;

/** Closed interval [lo, hi] with lo <= hi. */
export const Interval = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { message: 'interval lo must be <= hi' });
export type Interval = z.infer<typeof Interval>;

/**
 * Where a parameter value comes from.
 * - derived: computed from data in the pipeline
 * - proxy: computed from data, but stands in for a quantity the data cannot identify directly
 * - assumption: not identified by the data; a literature or engineering default
 */
export const Provenance = z.enum(['derived', 'proxy', 'assumption']);
export type Provenance = z.infer<typeof Provenance>;

/**
 * A scalar parameter with provenance. `spread` is the relative half-width of a per-driver
 * uniform multiplier: a driver's value is value * (1 + spread * u), u ~ U[-1, 1].
 */
export const Param = z.object({
  value: z.number(),
  provenance: Provenance,
  note: z.string(),
  spread: z.number().min(0).max(0.9).default(0),
});
export type Param = z.infer<typeof Param>;

/**
 * A distribution with provenance. `quantiles` holds values at equally spaced probabilities
 * 0, 1/(n-1), ..., 1 (non-decreasing); sampling is piecewise-linear inverse CDF, which needs
 * only one uniform draw and arithmetic (deterministic across JS engines).
 */
export const Dist = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'),
    value: z.number(),
    provenance: Provenance,
    note: z.string(),
  }),
  z.object({
    kind: z.literal('quantiles'),
    q: z
      .array(z.number())
      .min(2)
      .refine((q) => q.every((v, i) => i === 0 || v >= q[i - 1]!), {
        message: 'quantiles must be non-decreasing',
      }),
    provenance: Provenance,
    note: z.string(),
  }),
]);
export type Dist = z.infer<typeof Dist>;
