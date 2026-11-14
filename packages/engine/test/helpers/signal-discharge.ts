/**
 * The T15 measurement (signalised approach, saturated, per-cycle discharge) and the least-squares
 * fit, shared by T15 and the plain-link discharge comparison. See T15's header for the setup.
 */
import { classSet, linkStat, makeSim } from './m2.ts';
import { ARM, armLinks, junctionScenario } from './m3.ts';

export const LEN = 600;
export const arms = [ARM(0, 3.5, 1, LEN), ARM(90, 3.5, 1, LEN), ARM(180, 3.5, 1, LEN), ARM(270, 3.5, 1, LEN)];
export const T15_CLASS = { id: 'car' as const, length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } };
export const classes = classSet([T15_CLASS]);
export const DT = 0.2;
export const K = 10;
export const WARM = 900;
export const E = 1 + 0.2;
export const GREENS = [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60];
export const log = (line: string) => (globalThis as unknown as { console: { log(s: string): void } }).console.log(line);

export function perCycle(g: number): { mean: number; counts: number[]; minQueueEndGreen: number; minQueueBoundary: number } {
  const base = makeSim(junctionScenario({ arms }), classes).network;
  const links = armLinks(base);
  const order = [...links.keys()].sort((x, y) => x - y);
  const a0 = links.get(order[0]!)!;
  const a2 = links.get(order[2]!)!;
  const from = (l: string) => base.movements.filter((m) => m.fromLink === l).map((m) => m.id);
  const through = base.movements.find((m) => m.fromLink === a0.inLink && m.toLink === a2.outLink)!.id;
  const node = base.signals[0]!.node;
  const sim = makeSim(
    junctionScenario({
      arms,
      od: [{ origin: `arm${order[0]}_in`, destination: `arm${order[2]}_out`, rateVph: 3000 }],
      signalOverrides: [
        { node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: g, protected: from(a0.inLink) }, { greenS: 10, protected: from(a2.inLink) }] },
      ],
    }),
    classes,
  );
  const C = g + 20;
  const perC = Math.round(C / DT);
  const greenSteps = Math.round(g / DT); // phase A green is [0, g) in every cycle (offset 0)
  sim.advance(perC * Math.ceil(WARM / C));
  const queued = () => sim.vehicles().filter((v) => v.link === a0.inLink && v.v < 0.5).length;
  const counts: number[] = [];
  let minQueueEndGreen = Infinity;
  let minQueueBoundary = Infinity;
  for (let k = 0; k < K; k++) {
    minQueueBoundary = Math.min(minQueueBoundary, queued());
    const e0 = linkStat(sim, through).entered;
    sim.advance(greenSteps - 1); // last step of green: t = start + g − dt
    minQueueEndGreen = Math.min(minQueueEndGreen, queued());
    sim.advance(perC - greenSteps + 1);
    counts.push(linkStat(sim, through).entered - e0);
  }
  return { mean: counts.reduce((a, b) => a + b, 0) / K, counts, minQueueEndGreen, minQueueBoundary };
}

/** least-squares line and the residual bound factors κ_i = |1 − H_ii| + Σ_{j≠i} |H_ij| */
export function fit(x: number[], y: number[]) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - mx) * (v - mx), 0);
  const slope = x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0) / sxx;
  const icpt = my - slope * mx;
  const H = (i: number, j: number) => 1 / n + ((x[i]! - mx) * (x[j]! - mx)) / sxx;
  const kappa = x.map((_, i) => x.reduce((a, _v, j) => a + (j === i ? Math.abs(1 - H(i, i)) : Math.abs(H(i, j))), 0));
  return { slope, icpt, kappa };
}

