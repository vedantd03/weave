/**
 * M3 test scaffolding: spec-literal references for signals (§3.2) and gap acceptance (§3.3),
 * Harders' capacity, junction scenario builders, network graph utilities and the no-collision
 * invariant. Nothing here imports engine code except through makeSim (helpers/m2.ts).
 */
import { SignalPlan, type Network, type ScenarioInput } from '../../src/schema/index.ts';
import type { M2Sim, VView } from './m2.ts';

/* ---------- signals (§3.2), literal reading ---------- */

export const SIG_SPEC = { RED: 0, AMBER: 1, GREEN: 2, PERMISSIVE: 3, NONE: 255 } as const;
export type Plan = ReturnType<typeof SignalPlan.parse>;

export function plan(p: unknown): Plan {
  return SignalPlan.parse(p);
}

export function cycleRef(p: Plan): number {
  return p.phases.reduce((a, ph) => a + ph.greenS + p.amberS + p.allRedS, 0);
}

/**
 * signalState per §3.2 (as amended): with "in phase i" = protected or permissive in phase i,
 * - amber window: in phase i → AMBER, unless also in phase i+1 (then it keeps its phase-i state);
 * - all-red window: in phase i → RED, unless also in phase i+1 (then it keeps its phase-i state);
 * - otherwise RED.
 */
export function sigRef(p: Plan, id: string, t: number): 0 | 1 | 2 | 3 {
  const C = cycleRef(p);
  let tau = (t - p.offsetS) % C;
  if (tau < 0) tau += C;
  let start = 0;
  const n = p.phases.length;
  for (let i = 0; i < n; i++) {
    const ph = p.phases[i]!;
    const next = p.phases[(i + 1) % n]!;
    const own: 0 | 2 | 3 = ph.protected.includes(id) ? SIG_SPEC.GREEN : ph.permissive.includes(id) ? SIG_SPEC.PERMISSIVE : SIG_SPEC.RED;
    const inNext = next.protected.includes(id) || next.permissive.includes(id);
    if (tau < start + ph.greenS) return own;
    if (tau < start + ph.greenS + p.amberS) {
      if (own === SIG_SPEC.RED) return SIG_SPEC.RED;
      return inNext ? own : SIG_SPEC.AMBER;
    }
    if (tau < start + ph.greenS + p.amberS + p.allRedS) {
      if (own === SIG_SPEC.RED) return SIG_SPEC.RED;
      return inNext ? own : SIG_SPEC.RED;
    }
    start += ph.greenS + p.amberS + p.allRedS;
  }
  return SIG_SPEC.RED;
}

/* ---------- gap acceptance (§3.3) ---------- */

/** Reference saturatedDischarge: earliest instant ≥ prev + tf (≥ 0 first) with time to the
 * next major arrival (strictly after the instant) ≥ tc; entries at major instants allowed;
 * entries only at t < horizon (§3.3, exclusive). */
export function dischargeRef(majors: readonly number[], tc: number, tf: number, horizon: number): number[] {
  const out: number[] = [];
  let t = 0;
  let j = 0; // index of the first major arrival strictly after t
  for (;;) {
    while (j < majors.length && majors[j]! <= t) j++;
    if (t >= horizon) break;
    const next = j < majors.length ? majors[j]! : Infinity;
    if (next - t >= tc) {
      out.push(t);
      t = t + tf;
    } else {
      t = next; // wait until that major has passed
    }
  }
  return out.filter((x) => x < horizon);
}

/** Harders (1968) capacity q·e^{−q tc}/(1 − e^{−q tf}) and the per-gap count moments. */
export function harders(q: number, tc: number, tf: number) {
  const p = Math.exp(-q * tc);
  const r = Math.exp(-q * tf);
  const En = p / (1 - r);
  const En2 = (p * (1 + r)) / ((1 - r) * (1 - r));
  return { capacity: q * En, En, En2 };
}

/* ---------- junction scenarios ---------- */

export interface Arm {
  angleDeg: number;
  inWidthM: number;
  outWidthM: number;
  inLanes: number;
  outLanes: number;
  lengthM?: number;
}

export function junctionScenario(o: {
  arms: Arm[];
  control?: 'signal' | 'priority';
  majorArms?: [number, number];
  flyover?: Record<string, unknown>;
  od?: { origin: string; destination: string; rateVph: number }[];
  composition?: ScenarioInput['composition'];
  mode?: 'strip' | 'lane';
  seed?: number;
  signalOverrides?: unknown[];
  boxCompliance?: number;
  speedLimitMps?: number;
}): ScenarioInput {
  return {
    version: 1,
    id: 'test-junction',
    name: 'test junction',
    network: {
      kind: 'generator',
      params: {
        generator: 'junction',
        arms: o.arms,
        control: o.control ?? 'signal',
        ...(o.majorArms ? { majorArms: o.majorArms } : {}),
        ...(o.flyover ? { flyover: o.flyover } : {}),
        ...(o.speedLimitMps ? { speedLimitMps: o.speedLimitMps } : {}),
      } as never,
    },
    od: o.od ?? [],
    composition: o.composition ?? { car: 1 },
    mode: o.mode ?? 'lane',
    durationS: 4 * 3600,
    warmupS: 0,
    seed: o.seed ?? 1,
    signalOverrides: (o.signalOverrides ?? []) as never,
    boxCompliance: o.boxCompliance ?? 1,
  };
}

export const ARM = (angleDeg: number, w = 3.5, lanes = 1, lengthM = 250): Arm => ({
  angleDeg, inWidthM: w, outWidthM: w, inLanes: lanes, outLanes: lanes, lengthM,
});

/** Map arm index → its in/out link ids, from the zones arm{k}_in / arm{k}_out. */
export function armLinks(net: Network): Map<number, { inLink: string; outLink: string }> {
  const m = new Map<number, { inLink: string; outLink: string }>();
  for (const z of net.zones) {
    const r = /^arm(\d+)_(in|out)$/.exec(z.id);
    if (!r) continue;
    const k = Number(r[1]);
    const e = m.get(k) ?? { inLink: '', outLink: '' };
    if (r[2] === 'in') e.inLink = z.link;
    else e.outLink = z.link;
    m.set(k, e);
  }
  return m;
}

/** Links reachable from `from` by following movements (BFS). */
export function reachableLinks(net: Network, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const l = queue.shift()!;
    for (const m of net.movements) {
      if (m.fromLink === l && !seen.has(m.toLink)) {
        seen.add(m.toLink);
        queue.push(m.toLink);
      }
    }
  }
  return seen;
}

/* ---------- invariants ---------- */

/** Pairs on the same segment with overlapping strip spans and overlapping (s − length, s). */
export function collisions(vs: readonly VView[]): string[] {
  const out: string[] = [];
  const byLink = new Map<string, VView[]>();
  for (const v of vs) byLink.set(v.link, [...(byLink.get(v.link) ?? []), v]);
  for (const [link, list] of byLink) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.lo > b.hi || b.lo > a.hi) continue;
        const overlap = Math.min(a.s, b.s) - Math.max(a.s - a.length, b.s - b.length);
        if (overlap > 1e-9) out.push(`${link}: ${a.id}@${a.s.toFixed(3)} & ${b.id}@${b.s.toFixed(3)}`);
      }
    }
  }
  return out;
}

/** §3.4 item 6: { detected, sinceS, junctions: [{ node, sinceS }] } or null. */
export interface Gridlock {
  detected: boolean;
  sinceS: number;
  junctions: { node: string; sinceS: number }[];
}
export type M3Sim = M2Sim & {
  gridlock(): Gridlock | null;
  diagnostics(): { guardActivations: number } & Record<string, unknown>;
};

/** Distance from point p to polyline pl (plan view). */
export function distToPolyline(p: readonly number[], pl: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1]!;
    const b = pl[i]!;
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    const L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / L2));
    best = Math.min(best, Math.hypot(p[0]! - (a[0]! + t * dx), p[1]! - (a[1]! + t * dy)));
  }
  return best;
}

/* ---------- routing reference (§2.1 cost with junction penalties, §2.8 movement limit) ---------- */

export const plen = (pl: readonly (readonly number[])[]) => {
  let s = 0;
  for (let i = 1; i < pl.length; i++) s += Math.hypot(pl[i]![0]! - pl[i - 1]![0]!, pl[i]![1]! - pl[i - 1]![1]!);
  return s;
};

/** Test-local Dijkstra over segments (links → movements → links), cost per §2.1. */
export function cheapest(net: Network, from: string, to: string): { cost: number; path: string[] } {
  const link = new Map(net.links.map((l) => [l.id, l]));
  const segCost = (id: string): number => {
    const l = link.get(id);
    if (l) return plen(l.polyline) / l.speedLimitMps;
    const m = net.movements.find((x) => x.id === id)!;
    const v = Math.min(link.get(m.fromLink)!.speedLimitMps, link.get(m.toLink)!.speedLimitMps);
    const pen = m.control === 'signal' ? 15 : m.control === 'minor' ? 5 : 0;
    return plen(m.path) / v + pen;
  };
  const next = (id: string): string[] =>
    link.has(id) ? net.movements.filter((m) => m.fromLink === id).map((m) => m.id) : [net.movements.find((m) => m.id === id)!.toLink];
  const dist = new Map<string, number>([[from, segCost(from)]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    for (const [k, d] of dist) if (!done.has(k) && (u === null || d < dist.get(u)!)) u = k;
    if (u === null) throw new Error(`${to} unreachable from ${from}`);
    if (u === to) break;
    done.add(u);
    for (const w of next(u)) {
      const d = dist.get(u)! + segCost(w);
      if (d < (dist.get(w) ?? Infinity)) {
        dist.set(w, d);
        prev.set(w, u);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return { cost: dist.get(to)!, path };
}

