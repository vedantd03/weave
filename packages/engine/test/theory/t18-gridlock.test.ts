/**
 * T18 — gridlock detector (docs/MODEL.md §3.4 item 6). sim.gridlock() returns
 * { detected, sinceS, junctions: [{ node, sinceS }] } or null.
 * - Whole network: locked after ≥ 300 s with no vehicle > 0.1 m/s, nothing inserted or exited,
 *   onNetwork > 0.
 * - Per junction (a node with ≥ 2 movements; region = vehicles on its movements plus fronts
 *   within 50 m of the end of its incoming links): locked after ≥ 300 s with a non-empty
 *   region, no region vehicle > 0.1 m/s, nobody entering or leaving its movements.
 * Free-flowing scenarios never report it.
 *
 * Circular blockage: a ring (L = 128 m) with N = round(156.25·0.128) = 20 cars of length 4.5 m
 * evenly spaced at 6.4 m, so every net gap is 1.9 m < s0 = 2 m. At v = 0 the IDM acceleration
 * a(1 − (s0/1.9)²) < 0, so the stop branch keeps every vehicle at rest forever: a closed loop of
 * vehicles each waiting for the one ahead. sinceS is the time at which the stalled condition
 * began (§3.4; here 0), so sinceS ≤ t − 300.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';
import { ringClassSet, ringScenario } from '../helpers/ring.ts';
import type { M3Sim } from '../helpers/m3.ts';
import { Network } from '../../src/schema/index.ts';

const DT = 0.2;
const notDetected = (g: { detected: boolean } | null) => g === null || g.detected === false;

describe('T18 gridlock detection', () => {
  it('a jammed ring is reported after 300 s, not before', () => {
    const sim = makeSim(
      ringScenario({ circumferenceM: 128, densityPerKm: 156.25, jitterM: 0, seed: 1 }),
      ringClassSet({ v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 }, 4.5),
    ) as unknown as M3Sim;
    expect(sim.vehicleCount()).toBe(20);
    sim.advance(Math.round(290 / DT));
    for (const v of sim.vehicles()) expect(v.v).toBeLessThanOrEqual(0.1);
    expect(notDetected(sim.gridlock())).toBe(true);
    sim.advance(Math.round(20 / DT)); // t = 310 s
    const g = sim.gridlock();
    expect(g).not.toBeNull();
    expect(g!.detected).toBe(true);
    expect(g!.sinceS).toBeGreaterThanOrEqual(0);
    expect(g!.sinceS).toBeLessThanOrEqual(sim.t - 300 + 1e-9);
    // the ring's only node has a single (free) movement: not a junction
    expect(g!.junctions).toEqual([]);
    expect(sim.vehicleCount()).toBe(20); // never teleported
  });

  it('a free-flowing ring never reports gridlock', () => {
    const sim = makeSim(
      ringScenario({ circumferenceM: 300, densityPerKm: 40, jitterM: 1, seed: 2 }),
      ringClassSet({ v0: 15, T: 1.2, s0: 2, a: 2, b: 2 }, 5),
    ) as unknown as M3Sim;
    for (let k = 0; k < 20; k++) {
      sim.advance(Math.round(60 / DT));
      expect(notDetected(sim.gridlock())).toBe(true);
    }
  });

  it('a corridor with demand never reports gridlock', () => {
    const sim = makeSim(
      corridorScenario({ lengthM: 800, widthM: 7, lanes: 2, rateVph: 1500, mode: 'lane', seed: 3 }),
      classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 14, T: 1.2, s0: 2, a: 1.5, b: 2 } }]),
    ) as unknown as M3Sim;
    for (let k = 0; k < 15; k++) {
      sim.advance(Math.round(60 / DT));
      expect(notDetected(sim.gridlock())).toBe(true);
    }
  });
});

describe('T18 per-junction gridlock', () => {
  // Two components. Part 1: link a (200 m) into junction J with two movements (a → b, a → b2),
  // both with band [0, 3.0]. A 3.2 m-wide truck placed on a can never enter either (§2.2), so it
  // stops before the end of a: J's region (fronts within 50 m of the end of a) holds one stopped
  // vehicle and nobody enters or leaves J's movements → J locks 300 s after the truck stalls.
  // Part 2: an unrelated corridor c with demand keeps flowing, so the whole-network rule
  // (no vehicle > 0.1 m/s, nothing inserted or exited) never holds.
  type P = [number, number];
  const link = (id: string, from: string, to: string, pl: P[], w: number) => ({ id, from, to, polyline: pl, widthM: w, lanes: 1, speedLimitMps: 13 });
  const mv = (id: string, toLink: string, path: P[]) => ({
    id, node: 'J', fromLink: 'a', toLink, path, widthM: 3.0, fromLateral: [0, 3.0] as P, toLateral: [0, 3.0] as P, control: 'free' as const,
  });
  const net = Network.parse({
    version: 1, id: 'two-parts', name: 'two parts',
    nodes: [
      { id: 'J0', x: 0, y: 0, kind: 'boundary' }, { id: 'J', x: 200, y: 0, kind: 'diverge' },
      { id: 'J1', x: 300, y: 20, kind: 'boundary' }, { id: 'J2', x: 300, y: -20, kind: 'boundary' },
      { id: 'P0', x: 0, y: 200, kind: 'boundary' }, { id: 'P1', x: 500, y: 200, kind: 'boundary' },
    ],
    links: [
      link('a', 'J0', 'J', [[0, 0], [200, 0]], 3.5),
      link('b', 'J', 'J1', [[205, 1], [300, 20]], 3.0),
      link('b2', 'J', 'J2', [[205, -1], [300, -20]], 3.0),
      link('c', 'P0', 'P1', [[0, 200], [500, 200]], 3.5),
    ],
    movements: [mv('m', 'b', [[200, 0], [205, 1]]), mv('m2', 'b2', [[200, 0], [205, -1]])],
    zones: [
      { id: 'out1', link: 'b', role: 'out' },
      { id: 'in2', link: 'c', role: 'in' },
      { id: 'out2', link: 'c', role: 'out' },
    ],
  });

  it('one junction locks while the rest flows: only that node is listed', () => {
    const sim = makeSim(
      {
        version: 1, id: 'g', name: 'g', network: { kind: 'custom', id: 'two-parts' },
        od: [{ origin: 'in2', destination: 'out2', rateVph: 1200 }], composition: { car: 1 }, mode: 'lane',
        durationS: 3600, warmupS: 0, seed: 18,
      },
      classSet([
        { id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } },
        { id: 'truck', length: 9, width: 3.2, idm: { v0: 10, T: 2, s0: 2, a: 2, b: 2 } },
      ]),
      net,
    ) as unknown as M3Sim;
    sim.addVehicle({ classId: 'truck', link: 'a', s: 150, y: 1.75, v: 5 });
    // stalled-since: the first time the truck is (and stays) at ≤ 0.1 m/s
    let stalledAt = -1;
    let exitedBefore = 0;
    for (let k = 1; k <= Math.round(700 / DT); k++) {
      sim.advance(1);
      const truck = sim.vehicles().find((v) => v.classId === 'truck')!;
      expect(truck.link).toBe('a');
      if (truck.v <= 0.1 && stalledAt < 0) stalledAt = sim.t;
      if (truck.v > 0.1) stalledAt = -1;
      if (Math.abs(sim.t - 400) < 1e-9) exitedBefore = sim.counters().exited;
      if (stalledAt >= 0 && sim.t < stalledAt + 300 - 1) {
        const g = sim.gridlock();
        expect(g === null || g.junctions.length === 0).toBe(true);
      }
    }
    expect(stalledAt).toBeGreaterThan(0);
    expect(stalledAt).toBeLessThan(400 - 1e-9); // premise: ≥ 300 s of stall by t = 700
    // premise: the network-wide rule cannot hold (part 2 keeps flowing)
    expect(sim.counters().exited).toBeGreaterThan(exitedBefore);
    expect(Math.max(...sim.vehicles().filter((v) => v.link === 'c').map((v) => v.v))).toBeGreaterThan(0.1);
    const g = sim.gridlock();
    expect(g).not.toBeNull();
    expect(g!.detected).toBe(true);
    expect(g!.junctions.map((j) => j.node)).toEqual(['J']);
    const j = g!.junctions[0]!;
    // the junction's stall began when its only region vehicle stopped (±1 step of detection)
    expect(Math.abs(j.sinceS - stalledAt)).toBeLessThanOrEqual(DT + 1e-9);
    expect(j.sinceS).toBeLessThanOrEqual(sim.t - 300 + 1e-9);
    expect(g!.sinceS).toBe(j.sinceS); // earliest stall = the junction's
  });
});
