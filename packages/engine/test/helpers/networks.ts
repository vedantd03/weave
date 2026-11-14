/**
 * Hand-built networks (validated by the zod Network schema) for demand and routing tests.
 * They are passed to createSim through its `network` argument with a scenario whose network
 * source is { kind: 'file', id: 'silkboard' } (the only file id the schema allows; MODEL.md §1.7
 * createSim takes the Network object explicitly).
 */
import { Network } from '../../src/schema/index.ts';
import type { ScenarioInput } from '../../src/schema/index.ts';

type P = [number, number];
const link = (id: string, from: string, to: string, polyline: P[], widthM: number, lanes: number, speedLimitMps: number) => ({
  id, from, to, polyline, widthM, lanes, speedLimitMps,
});
const free = (id: string, node: string, fromLink: string, toLink: string, path: P[], widthM: number, fromLateral: P, toLateral: P) => ({
  id, node, fromLink, toLink, path, widthM, fromLateral, toLateral, control: 'free' as const,
});

/**
 * Diverge: a (500 m, 7 m, 2 lanes) splits at n1 into b and c (3.5 m, 1 lane each).
 * Movement ab takes the left half [0, 3.5] of a, ac the right half [3.5, 7].
 * Zones: in (a), out1 (b), out2 (c); in2 sits on b, from where c is unreachable.
 */
export function divergeNetwork(withIn2 = false): Network {
  return Network.parse({
    version: 1,
    id: 'diverge',
    name: 'diverge',
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: 'boundary' },
      { id: 'n1', x: 500, y: 0, kind: 'diverge' },
      { id: 'n2', x: 800, y: 0, kind: 'boundary' },
      { id: 'n3', x: 800, y: -100, kind: 'boundary' },
    ],
    links: [
      link('a', 'n0', 'n1', [[0, -3.5], [500, -3.5]], 7, 2, 40),
      link('b', 'n1', 'n2', [[505, -1.75], [800, -1.75]], 3.5, 1, 40),
      link('c', 'n1', 'n3', [[505, -5.25], [800, -100]], 3.5, 1, 40),
    ],
    movements: [
      free('ab', 'n1', 'a', 'b', [[500, -1.75], [505, -1.75]], 3.5, [0, 3.5], [0, 3.5]),
      free('ac', 'n1', 'a', 'c', [[500, -5.25], [505, -5.25]], 3.5, [3.5, 7], [0, 3.5]),
    ],
    zones: [
      { id: 'in', link: 'a', role: 'in' },
      ...(withIn2 ? [{ id: 'in2', link: 'b', role: 'in' as const }] : []),
      { id: 'out1', link: 'b', role: 'out' },
      { id: 'out2', link: 'c', role: 'out' },
    ],
  });
}

/**
 * Two parallel paths between n1 and n2: b (via (400, 150), 492.1 m) and c (straight, 390 m),
 * each followed by d. Movement paths are all 5 m, so they add the same cost to both routes.
 */
export function parallelNetwork(speedB: number, speedC: number): Network {
  return Network.parse({
    version: 1,
    id: 'parallel',
    name: 'parallel',
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: 'boundary' },
      { id: 'n1', x: 200, y: 0, kind: 'diverge' },
      { id: 'n2', x: 600, y: 0, kind: 'merge' },
      { id: 'n3', x: 805, y: 0, kind: 'boundary' },
    ],
    links: [
      link('a', 'n0', 'n1', [[0, 0], [200, 0]], 3.5, 1, 40),
      link('b', 'n1', 'n2', [[205, 0], [400, 150], [595, 0]], 3.5, 1, speedB),
      link('c', 'n1', 'n2', [[205, 0], [595, 0]], 3.5, 1, speedC),
      link('d', 'n2', 'n3', [[600, 0], [800, 0]], 3.5, 1, 40),
    ],
    movements: [
      free('ab', 'n1', 'a', 'b', [[200, 0], [205, 0]], 3.5, [0, 3.5], [0, 3.5]),
      free('ac', 'n1', 'a', 'c', [[200, 0], [205, 0]], 3.5, [0, 3.5], [0, 3.5]),
      free('bd', 'n2', 'b', 'd', [[595, 0], [600, 0]], 3.5, [0, 3.5], [0, 3.5]),
      free('cd', 'n2', 'c', 'd', [[595, 0], [600, 0]], 3.5, [0, 3.5], [0, 3.5]),
    ],
    zones: [
      { id: 'in', link: 'a', role: 'in' },
      { id: 'out', link: 'd', role: 'out' },
    ],
  });
}

export function fileScenario(o: {
  od: { origin: string; destination: string; rateVph: number }[];
  composition: ScenarioInput['composition'];
  mode?: 'strip' | 'lane';
  seed?: number;
}): ScenarioInput {
  return {
    version: 1,
    id: 'test-file-net',
    name: 'test file network',
    network: { kind: 'file', id: 'silkboard' },
    od: o.od,
    composition: o.composition,
    mode: o.mode ?? 'lane',
    durationS: 4 * 3600,
    warmupS: 0,
    seed: o.seed ?? 1,
  };
}
