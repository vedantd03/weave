import { z } from 'zod';
import { Id, Interval, Polyline } from './common.ts';

/**
 * Network contract. Coordinates are local metres (x east, y north) from an equirectangular
 * projection around the area centre. Lateral positions are metres measured from the LEFT edge
 * of the carriageway in the direction of travel (matches the Chennai data convention).
 */

export const NodeKind = z.enum(['plain', 'signal', 'priority', 'merge', 'diverge', 'boundary']);
export type NodeKind = z.infer<typeof NodeKind>;

export const Node = z.object({
  id: Id,
  x: z.number(),
  y: z.number(),
  kind: NodeKind,
  /** Vertical level: 0 ground, 1 flyover deck, ... Movements only conflict within one node. */
  layer: z.number().int().min(0).default(0),
});
export type Node = z.infer<typeof Node>;

export const Link = z.object({
  id: Id,
  from: Id,
  to: Id,
  polyline: Polyline,
  widthM: z.number().positive(),
  /** Nominal lane count; used by lane mode (lane width = widthM / lanes). */
  lanes: z.number().int().min(1),
  speedLimitMps: z.number().positive(),
  /** Drawing/vertical level. Ramps carry the level they climb to and an elevation profile. */
  layer: z.number().int().min(0).default(0),
  zFromM: z.number().default(0),
  zToM: z.number().default(0),
});
export type Link = z.infer<typeof Link>;

export const ConflictType = z.enum(['crossing', 'merging', 'diverging']);
export type ConflictType = z.infer<typeof ConflictType>;

/** A conflict area between two movements at the same node, as arc-length intervals on each path. */
export const Conflict = z.object({
  movement: Id,
  type: ConflictType,
  self: Interval,
  other: Interval,
});
export type Conflict = z.infer<typeof Conflict>;

export const MovementControl = z.enum(['signal', 'major', 'minor', 'free']);
export type MovementControl = z.infer<typeof MovementControl>;

export const Movement = z.object({
  id: Id,
  node: Id,
  fromLink: Id,
  toLink: Id,
  /** Centreline of the internal path through the junction box. */
  path: Polyline,
  widthM: z.number().positive(),
  /** Lateral band of fromLink (from its left edge) that may use this movement. */
  fromLateral: Interval,
  /** Lateral band of toLink where this movement lands. */
  toLateral: Interval,
  control: MovementControl,
  /** Optional: computed by the engine from geometry when absent. */
  conflicts: z.array(Conflict).optional(),
  /** Optional: netconvert foe list, used only as a cross-check of computed conflicts. */
  foes: z.array(Id).optional(),
});
export type Movement = z.infer<typeof Movement>;

export const Phase = z.object({
  greenS: z.number().positive(),
  protected: z.array(Id),
  permissive: z.array(Id).default([]),
});
export type Phase = z.infer<typeof Phase>;

/** Cycle length is derived: sum over phases of (greenS + amberS + allRedS). */
export const SignalPlan = z.object({
  node: Id,
  offsetS: z.number().min(0).default(0),
  amberS: z.number().min(0).default(3),
  allRedS: z.number().min(0).default(2),
  phases: z.array(Phase).min(1),
});
export type SignalPlan = z.infer<typeof SignalPlan>;

/** Boundary entry/exit points. IDs are stable across generator variants (e.g. flyover on/off). */
export const Zone = z.object({
  id: Id,
  link: Id,
  role: z.enum(['in', 'out']),
  label: z.string().optional(),
});
export type Zone = z.infer<typeof Zone>;

export const Network = z
  .object({
    version: z.literal(1),
    id: Id,
    name: z.string(),
    origin: z.object({ lat: z.number(), lon: z.number() }).optional(),
    nodes: z.array(Node),
    links: z.array(Link).min(1),
    movements: z.array(Movement).default([]),
    signals: z.array(SignalPlan).default([]),
    zones: z.array(Zone).default([]),
  })
  .superRefine((net, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (kind: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) issue(`duplicate ${kind} id: ${id}`);
        seen.add(id);
      }
      return seen;
    };
    const nodes = unique('node', net.nodes.map((n) => n.id));
    const links = unique('link', net.links.map((l) => l.id));
    const movements = unique('movement', net.movements.map((m) => m.id));
    unique('zone', net.zones.map((z) => z.id));
    for (const l of net.links) {
      if (!nodes.has(l.from)) issue(`link ${l.id}: unknown from-node ${l.from}`);
      if (!nodes.has(l.to)) issue(`link ${l.id}: unknown to-node ${l.to}`);
    }
    const linkById = new Map(net.links.map((l) => [l.id, l]));
    for (const m of net.movements) {
      if (!nodes.has(m.node)) issue(`movement ${m.id}: unknown node ${m.node}`);
      const from = linkById.get(m.fromLink);
      const to = linkById.get(m.toLink);
      if (!from) issue(`movement ${m.id}: unknown fromLink ${m.fromLink}`);
      if (!to) issue(`movement ${m.id}: unknown toLink ${m.toLink}`);
      if (from && from.to !== m.node) issue(`movement ${m.id}: fromLink does not end at node`);
      if (to && to.from !== m.node) issue(`movement ${m.id}: toLink does not start at node`);
      for (const c of m.conflicts ?? []) {
        if (!movements.has(c.movement)) issue(`movement ${m.id}: conflict with unknown ${c.movement}`);
      }
    }
    for (const s of net.signals) {
      if (!nodes.has(s.node)) issue(`signal plan: unknown node ${s.node}`);
      for (const p of s.phases) {
        for (const id of [...p.protected, ...p.permissive]) {
          if (!movements.has(id)) issue(`signal plan ${s.node}: unknown movement ${id}`);
        }
      }
    }
    for (const z of net.zones) {
      if (!links.has(z.link)) issue(`zone ${z.id}: unknown link ${z.link}`);
    }
  });
export type Network = z.infer<typeof Network>;
