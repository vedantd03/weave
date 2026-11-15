import type { Sim } from '../sim/sim.ts';

/** Per-approach, per-movement and per-OD results of one run (docs/MODEL.md §7.2). */

export interface ApproachRow {
  zone: string;
  generated: number;
  completed: number;
  meanDelayS: number;
  throughputVph: number;
  meanEntryQueue: number;
  maxEntryQueue: number;
}
export interface MovementRow {
  id: string;
  node: string;
  entered: number;
  flowVph: number;
  meanTimeS: number;
  meanDelayS: number;
}
export interface OdRow {
  origin: string;
  destination: string;
  generated: number;
  completed: number;
  meanDelayS: number;
  meanTravelTimeS: number;
}
export interface Breakdown {
  approaches: ApproachRow[];
  movements: MovementRow[];
  od: OdRow[] | null;
}

const OD_LIMIT = 40;
const QUEUE_SAMPLE_S = 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function breakdown(sim: Sim, warmupS: number): Breakdown {
  const D = sim.t;
  const w = warmupS;
  const inW = (t: number) => t >= w - 1e-9 && t <= D + 1e-9;
  const done = new Map(sim.trips().map((r) => [r.id, r]));
  const onNet = new Map(sim.vehicles().map((v) => [v.id, v]));
  const gen = sim.generatedLog();
  /** §5.2 delay of a generated vehicle at time D (unfinished trips: delay so far). */
  const delayOf = (g: (typeof gen)[number]) => {
    const c = done.get(g.id);
    if (c) return c.tExit - c.tGen - c.freeFlowS;
    const v = onNet.get(g.id);
    return D - g.tGen - (v ? v.freeFlowTravelledS : 0);
  };
  const tInsertOf = (id: number) => done.get(id)?.tInsert ?? onNet.get(id)?.tInsert ?? Infinity;
  const window = gen.filter((g) => inW(g.tGen));
  const span = D - w;

  // Approaches (origin zones), in OD order of first appearance.
  const zones = [...new Set(sim.scenario.od.map((r) => r.origin))];
  const samples: number[] = [];
  for (let tau = w; tau <= D + 1e-9; tau += QUEUE_SAMPLE_S) samples.push(tau);
  const approaches = zones.map((zone) => {
    const mine = window.filter((g) => g.origin === zone);
    const completed = mine.filter((g) => done.has(g.id));
    const all = gen.filter((g) => g.origin === zone);
    const queue = samples.map((tau) => all.filter((g) => g.tGen <= tau && tInsertOf(g.id) > tau).length);
    return {
      zone,
      generated: mine.length,
      completed: completed.length,
      meanDelayS: mean(mine.map(delayOf)),
      throughputVph: span > 0 ? (completed.length * 3600) / span : NaN,
      meanEntryQueue: mean(queue),
      maxEntryQueue: queue.length ? Math.max(...queue) : NaN,
    };
  });

  // Junction movements used by OD routes (nodes with >= 2 movements).
  const net = sim.network;
  const perNode = new Map<string, number>();
  for (const m of net.movements) perNode.set(m.node, (perNode.get(m.node) ?? 0) + 1);
  const mvById = new Map(net.movements.map((m) => [m.id, m]));
  const routes = sim.odRoutes();
  const used: string[] = [];
  const odUsing = new Map<string, Set<string>>(); // movement -> "origin>destination"
  for (const r of routes) {
    for (const s of r.segments) {
      const m = mvById.get(s);
      if (!m || (perNode.get(m.node) ?? 0) < 2) continue;
      if (!odUsing.has(s)) {
        odUsing.set(s, new Set());
        used.push(s);
      }
      odUsing.get(s)!.add(`${r.origin}>${r.destination}`);
    }
  }
  const ls = sim.linkStats();
  const movements = used.map((id) => {
    const st = ls[id]!;
    const keys = odUsing.get(id)!;
    return {
      id,
      node: mvById.get(id)!.node,
      entered: st.entered,
      flowVph: D > 0 ? (st.entered * 3600) / D : NaN,
      meanTimeS: st.travelTimeCount > 0 ? st.travelTimeSum / st.travelTimeCount : NaN,
      meanDelayS: mean(window.filter((g) => keys.has(`${g.origin}>${g.destination}`)).map(delayOf)),
    };
  });

  // OD pairs (small networks only).
  const pairs = sim.scenario.od.map((r) => [r.origin, r.destination] as const);
  const od =
    pairs.length > OD_LIMIT
      ? null
      : pairs.map(([o, d]) => {
          const mine = window.filter((g) => g.origin === o && g.destination === d);
          const comp = mine.map((g) => done.get(g.id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
          return {
            origin: o,
            destination: d,
            generated: mine.length,
            completed: comp.length,
            meanDelayS: mean(mine.map(delayOf)),
            meanTravelTimeS: mean(comp.map((c) => c.tExit - c.tGen)),
          };
        });
  return { approaches, movements, od };
}
