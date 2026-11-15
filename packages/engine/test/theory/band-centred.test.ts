/**
 * Revision 2 of the band rules (docs/MODEL.md §2.2 "band miss", §2.3 "Band-centred candidate").
 *
 * Band miss of a body [lo, hi] = [y − width/2, y + width/2] against an effective band [b0, b1]:
 *   miss = max(0, b0 − lo) + max(0, hi − b1): the body must lie inside the band, for every
 *   vehicle (the "cover the band" case for wider vehicles was reverted; a wider-than-band
 *   vehicle is stopped again, covered by lane-band.test.ts's 3.6 m truck).
 * Insertion adds y* = (b0 + b1)/2, clamped to [width/2, W − width/2] when width ≤ W, else W/2,
 * when no grid candidate fits.
 *
 * Exit bound for a vehicle alone on the network. It is inserted at the first step end after
 * tGen (< dt), at v_ins = v0_eff with no leader, and drives the route at v0_eff, which takes at
 * most freeFlowS (its front starts at s = length). The exit is detected at a step end (< dt).
 * Hence tExit − tGen ≤ freeFlowS + 2·dt.
 */
import { describe, expect, it } from 'vitest';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { classSet, makeSim, type ClassSpec } from '../helpers/m2.ts';

const DT = 0.2;
const DELTA = 0.25;
type P = [number, number];

function net(W: number, band: P, mvW: number, outW: number): Network {
  return Network.parse({
    version: 1, id: 'bc', name: 'band-centred',
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: 'boundary' }, { id: 'n1', x: 200, y: 0, kind: 'plain' }, { id: 'n2', x: 400, y: 0, kind: 'boundary' },
    ],
    links: [
      { id: 'a', from: 'n0', to: 'n1', polyline: [[0, -W / 2], [200, -W / 2]] as P[], widthM: W, lanes: Math.max(1, Math.round(W / 3)), speedLimitMps: 13 },
      { id: 'b', from: 'n1', to: 'n2', polyline: [[205, -outW / 2], [400, -outW / 2]] as P[], widthM: outW, lanes: 1, speedLimitMps: 13 },
    ],
    movements: [
      { id: 'm', node: 'n1', fromLink: 'a', toLink: 'b', path: [[200, -outW / 2], [205, -outW / 2]] as P[], widthM: mvW, fromLateral: band, toLateral: [0, mvW] as P, control: 'free' },
    ],
    zones: [{ id: 'in', link: 'a', role: 'in' }, { id: 'out', link: 'b', role: 'out' }],
  });
}
const scenario = (rateVph: number): ScenarioInput => ({
  version: 1, id: 'bc', name: 'bc', network: { kind: 'custom', id: 'bc' },
  od: rateVph > 0 ? [{ origin: 'in', destination: 'out', rateVph }] : [], composition: { bus: 1 },
  mode: 'strip', stripWidthM: DELTA, durationS: 3600, warmupS: 0, seed: 3,
});
const bus = (width: number, c0: number, maxLat = 0.6): ClassSpec => ({
  id: 'bus', length: 11, width, idm: { v0: 12, T: 1.5, s0: 2, a: 1, b: 1.5 }, c0, c1: 0, maxLat,
});

/** run with demand; returns first-seen y per vehicle, trips, and the final counters */
function runDemand(network: Network, cls: ClassSpec, rateVph: number, steps: number) {
  const sim = makeSim(scenario(rateVph), classSet([cls]), network);
  const firstY = new Map<number, number>();
  for (let k = 0; k < steps; k++) {
    sim.advance(1);
    for (const v of sim.vehicles()) if (!firstY.has(v.id) && v.link === 'a') firstY.set(v.id, v.y);
  }
  return { sim, firstY };
}

describe('§2.3 band-centred insertion candidate', () => {
  it('6 m link, band [3, 6], 2.89 m bus with c0 = 0.37: no grid candidate fits; inserted at y* = 4.5 and exits', () => {
    const W = 6;
    const band: P = [3, 6];
    const cls = bus(2.89, 0.37);
    // premise: every grid candidate y_m = h + m·Δ with y_m + h ≤ W misses the band
    const h = cls.width / 2 + cls.c0!;
    const grid: number[] = [];
    for (let m = 0; h + m * DELTA + h <= W + 1e-12; m++) grid.push(h + m * DELTA);
    expect(grid.length).toBeGreaterThan(0);
    for (const y of grid) expect(Math.max(0, band[0] - (y - cls.width / 2)) + Math.max(0, y + cls.width / 2 - band[1])).toBeGreaterThan(1e-3);
    // y* = (3 + 6)/2 = 4.5, inside [w/2, W − w/2] = [1.445, 4.555]; body [3.055, 5.945] ⊂ band
    const yStar = Math.min(W - cls.width / 2, Math.max(cls.width / 2, (band[0] + band[1]) / 2));
    expect(yStar).toBe(4.5);

    const { sim, firstY } = runDemand(net(W, band, 3, 3), cls, 300, 3000);
    expect(firstY.size).toBeGreaterThan(5);
    for (const [id, y] of firstY) expect(Math.abs(y - yStar), `vehicle ${id}`).toBeLessThanOrEqual(1e-9);
    const log = sim.generatedLog();
    const first = sim.trips().find((t) => t.id === log[0]!.id)!;
    expect(first).toBeDefined();
    expect(first.tExit - first.tGen).toBeLessThanOrEqual(first.freeFlowS + 2 * DT + 1e-9);
    // nobody is held at the link end: every vehicle generated ≥ 120 s before the end has left
    // (route ≈ 400 m at 12 m/s ≈ 34 s; insertion headway ≈ (s0 + v0·T + ℓ)/v0 ≈ 2.6 s ≪ 12 s
    // mean interarrival time)
    const done = new Set(sim.trips().map((t) => t.id));
    for (const r of log) if (r.tGen < sim.t - 120) expect(done.has(r.id), `vehicle ${r.id}`).toBe(true);
  });

  it('ADR-022: a 2.6 m bus enters a 3 m link with band [0, 3]: inserted at y* = 1.5, exits', () => {
    const W = 3;
    const band: P = [0, 3];
    const cls = bus(2.6, 0.37);
    // premise: 2h = 2·(1.3 + 0.37) = 3.34 > W, so there is no grid candidate at all
    expect(2 * (cls.width / 2 + cls.c0!)).toBeGreaterThan(W);
    // y* = clamp((0 + 3)/2, 1.3, 1.7) = 1.5; body [0.2, 2.8] lies inside the band (miss 0)
    const yStar = Math.min(W - cls.width / 2, Math.max(cls.width / 2, (band[0] + band[1]) / 2));
    expect(yStar).toBe(1.5);
    expect(Math.max(0, band[0] - (yStar - cls.width / 2)) + Math.max(0, yStar + cls.width / 2 - band[1])).toBe(0);
    const { sim, firstY } = runDemand(net(W, band, 3, 3), cls, 300, 3000);
    expect(firstY.size).toBeGreaterThan(5);
    for (const [id, y] of firstY) expect(Math.abs(y - yStar), `vehicle ${id}`).toBeLessThanOrEqual(1e-9);
    const log = sim.generatedLog();
    const first = sim.trips().find((t) => t.id === log[0]!.id)!;
    expect(first).toBeDefined();
    expect(first.tExit - first.tGen).toBeLessThanOrEqual(first.freeFlowS + 2 * DT + 1e-9);
  });
});

describe('§2.2 band miss on a link', () => {
  it('a 2.6 m bus at y = 1.5 on a 3 m link (body [0.2, 2.8] inside [0, 3]) is not stopped at the link end', () => {
    const sim = makeSim(scenario(0), classSet([bus(2.6, 0.37)]), net(3, [0, 3], 3, 3));
    const id = sim.addVehicle({ classId: 'bus', link: 'a', s: 50, y: 1.5, v: 10 });
    let reachedB = false;
    for (let k = 0; k < 600 && !reachedB; k++) {
      sim.advance(1);
      const v = sim.vehicles().find((x) => x.id === id);
      if (!v) break;
      // free road from v = 10 < v0 = 12: the IDM acceleration a(1 − (v/v0)^4) > 0, so without a
      // standing obstacle the speed never falls; 5 m/s leaves a wide margin
      if (v.link === 'a') expect(v.v).toBeGreaterThan(5);
      if (v.link === 'b' || v.link === 'm') reachedB = true;
    }
    expect(reachedB).toBe(true);
  });

  it('unchanged for narrow vehicles: a 2.0 m car with its body outside a [3, 6] band stops at the link end', () => {
    const car: ClassSpec = { id: 'car', length: 4.5, width: 2.0, idm: { v0: 12, T: 2, s0: 2, a: 2, b: 2 }, c0: 0.2, c1: 0, maxLat: 0 };
    const sim = makeSim({ ...scenario(0), composition: { car: 1 } }, classSet([car]), net(6, [3, 6], 3, 3));
    // body [1.0, 3.0]: width 2 ≤ 3, miss = max(0, 3 − 1) = 2 > ε; maxSpeedMps = 0 so it cannot move in
    sim.addVehicle({ classId: 'car', link: 'a', s: 100, y: 2.0, v: 10 });
    for (let k = 0; k < 500; k++) {
      sim.advance(1);
      const v = sim.vehicles()[0]!;
      expect(v.link).toBe('a');
      expect(v.s).toBeLessThan(200);
    }
    // ζ = 2·√(2/4) = 1.41: settles at gap s0 (T3); 100 s ≫ the approach time
    const v = sim.vehicles()[0]!;
    expect(v.v).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(200 - v.s - 2)).toBeLessThanOrEqual(1e-6);
  });
});
