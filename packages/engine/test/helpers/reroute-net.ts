/**
 * The deadlock-breaker networks of reroute.test.ts (§2.2), shared with the export tests.
 * "parallel": a (7 m) splits into ab (band [0, 3.5]) → b and ac (band [3.5, 7]) → c, both
 * leading to d. "diverge": b and c are separate exits; demand enters on up0, whose movement m0
 * feeds only the right half of a.
 */
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import type { ClassSpec } from './m2.ts';

type P = [number, number];
export const IDM = { v0: 12, T: 2, s0: 2, a: 2, b: 2 }; // ζ = 1.41: settles at gap s0 without overshoot
export const STUCK_CAR: ClassSpec = { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0 };
export const L_A = 300;

export function net(kind: 'parallel' | 'diverge'): Network {
  const link = (id: string, from: string, to: string, pl: P[], w: number, lanes = 1) => ({ id, from, to, polyline: pl, widthM: w, lanes, speedLimitMps: 13 });
  const mv = (id: string, node: string, fromLink: string, toLink: string, path: P[], fromLateral: P, w = 3.5) => ({
    id, node, fromLink, toLink, path, widthM: w, fromLateral, toLateral: [0, w] as P, control: 'free' as const,
  });
  const parallel = kind === 'parallel';
  return Network.parse({
    version: 1, id: kind, name: kind,
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: parallel ? 'boundary' : 'plain' }, { id: 'n1', x: L_A, y: 0, kind: 'diverge' },
      ...(parallel ? [] : [{ id: 'nu', x: -200, y: 0, kind: 'boundary' as const }]),
      { id: 'n2', x: 600, y: 0, kind: parallel ? 'merge' : 'boundary' },
      ...(parallel ? [{ id: 'n3', x: 805, y: 0, kind: 'boundary' as const }] : [{ id: 'n4', x: 600, y: -100, kind: 'boundary' as const }]),
    ],
    links: [
      link('a', 'n0', 'n1', [[0, -3.5], [L_A, -3.5]], 7, 2),
      ...(parallel ? [] : [link('up0', 'nu', 'n0', [[-200, -3.5], [-5, -3.5]], 7, 2)]),
      link('b', 'n1', 'n2', [[305, -1.75], [parallel ? 595 : 600, -1.75]], 3.5),
      link('c', 'n1', parallel ? 'n2' : 'n4', parallel ? [[305, -5.25], [450, -60], [595, -5.25]] : [[305, -5.25], [600, -100]], 3.5),
      ...(parallel ? [link('d', 'n2', 'n3', [[600, -1.75], [800, -1.75]], 3.5)] : []),
    ],
    movements: [
      mv('ab', 'n1', 'a', 'b', [[L_A, -1.75], [305, -1.75]], [0, 3.5]),
      mv('ac', 'n1', 'a', 'c', [[L_A, -5.25], [305, -5.25]], [3.5, 7]),
      // m0 feeds only the right half of a: demand vehicles insert there (band-only insertion,
      // §2.3) with their bodies fully inside ac's band, but are routed to b through ab
      ...(parallel ? [] : [{ ...mv('m0', 'n0', 'up0', 'a', [[-5, -5.25], [0, -5.25]], [3.5, 7]), toLateral: [3.5, 7] as P }]),
      ...(parallel
        ? [mv('bd', 'n2', 'b', 'd', [[595, -1.75], [600, -1.75]], [0, 3.5]), mv('cd', 'n2', 'c', 'd', [[595, -5.25], [600, -1.75]], [0, 3.5])]
        : []),
    ],
    zones: parallel
      ? [{ id: 'in', link: 'a', role: 'in' }, { id: 'out', link: 'd', role: 'out' }]
      : [{ id: 'in', link: 'up0', role: 'in' }, { id: 'out1', link: 'b', role: 'out' }, { id: 'out2', link: 'c', role: 'out' }],
  });
}

export const scenario = (id: string): ScenarioInput => ({
  version: 1, id, name: id, network: { kind: 'custom', id }, od: [], composition: { car: 1 },
  mode: 'strip', stripWidthM: 0.25, durationS: 3600, warmupS: 0, seed: 1,
});

