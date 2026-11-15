/**
 * §2.4 "Band-centred move (revision 2, strip mode only)". When a vehicle's body misses its next
 * movement's band and no grid candidate y + j·Δ (|j| ≤ J) fits it, one extra candidate is
 * evaluated: y* = clamp((b0 + b1)/2, width/2, W − width/2) (W/2 when width > W), provided
 * |y* − y| ≤ J·Δ. It is a band-seeking move (body inside the road; all safety checks apply).
 *
 * Scene (the Silk Board seed 47 case): link a, 10.5 m, 3 lanes, 200 m, feeding movement m with
 * fromLateral [0, 3.5] and width 3, so its effective band is [0, min(3.5, 0 + 3)] = [0, 3]
 * (§2.2). A 2.98 m bus stands at y = 1.61 (body [0.12, 3.10], miss 0.10) with gap s0 to the end
 * (IDM acceleration 0 at rest). maxSpeedMps = 0.6 m/s with Δ = 0.25 m gives J = floor(0.6/0.25) = 2.
 *
 * Time bound: the 0.11 m move at the standstill lateral speed 0.25·maxLat (§2.4, snapshot speed
 * 0) takes 0.11/0.15 s, rounded up to whole steps, plus one step for the decision. Inside the
 * band the end is no longer an obstacle; from rest the free IDM acceleration is ≥ a/2 for
 * v ≤ 0.84·v0, so the s0 = 2 m to the end take ≤ √(2·s0/(a/2)) s. Plus 2 steps for detection.
 */
import { describe, expect, it } from 'vitest';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { classSet, makeSim, type ClassSpec } from '../helpers/m2.ts';

const DT = 0.2;
const DELTA = 0.25;
const W = 10.5;
const L = 200;
const BAND: [number, number] = [0, 3];
type P = [number, number];

const net = Network.parse({
  version: 1, id: 'bcm', name: 'band-centred move',
  nodes: [{ id: 'n0', x: 0, y: 0, kind: 'boundary' }, { id: 'n1', x: L, y: 0, kind: 'plain' }, { id: 'n2', x: 400, y: 0, kind: 'boundary' }],
  links: [
    { id: 'a', from: 'n0', to: 'n1', polyline: [[0, -W / 2], [L, -W / 2]] as P[], widthM: W, lanes: 3, speedLimitMps: 13 },
    { id: 'b', from: 'n1', to: 'n2', polyline: [[205, -1.5], [400, -1.5]] as P[], widthM: 3, lanes: 1, speedLimitMps: 13 },
  ],
  movements: [
    { id: 'm', node: 'n1', fromLink: 'a', toLink: 'b', path: [[L, -1.5], [205, -1.5]] as P[], widthM: 3, fromLateral: [0, 3.5] as P, toLateral: [0, 3] as P, control: 'free' },
  ],
  zones: [{ id: 'in', link: 'a', role: 'in' }, { id: 'out', link: 'b', role: 'out' }],
});
const scenario = (mode: 'strip' | 'lane'): ScenarioInput => ({
  version: 1, id: 'bcm', name: 'bcm', network: { kind: 'custom', id: 'bcm' }, od: [], composition: { bus: 1 },
  mode, stripWidthM: DELTA, durationS: 3600, warmupS: 0, seed: 1,
});
const bus = (width: number): ClassSpec => ({
  id: 'bus', length: 11, width, idm: { v0: 12, T: 1.5, s0: 2, a: 1, b: 1.5 }, c0: 0.3, c1: 0, maxLat: 0.6,
});
const miss = (y: number, w: number) => {
  const lo = y - w / 2;
  const hi = y + w / 2;
  return w <= BAND[1] - BAND[0] ? Math.max(0, BAND[0] - lo) + Math.max(0, hi - BAND[1]) : Math.max(0, lo - BAND[0]) + Math.max(0, BAND[1] - hi);
};
const inRoad = (y: number, w: number) => y - w / 2 >= 0 && y + w / 2 <= W;

function run(width: number, y0: number, mode: 'strip' | 'lane', steps: number) {
  const cls = bus(width);
  const sim = makeSim(scenario(mode), classSet([cls]), net);
  const id = sim.addVehicle({ classId: 'bus', link: 'a', s: L - cls.idm.s0, y: y0, v: 0 });
  const ys: number[] = [];
  let enteredAt = -1;
  let yAtEntry = NaN;
  let lastY = y0;
  for (let k = 0; k < steps; k++) {
    sim.advance(1);
    const v = sim.vehicles().find((x) => x.id === id);
    if (!v) break;
    if (v.link === 'a') {
      ys.push(v.y);
      lastY = v.y;
    } else if (enteredAt < 0) {
      enteredAt = sim.t;
      yAtEntry = lastY;
    }
  }
  return { ys, enteredAt, yAtEntry, cls };
}

describe('§2.4 band-centred move (strip mode)', () => {
  it('2.98 m bus at y = 1.61 before band [0, 3]: no grid candidate fits; it moves to y* = 1.5 and enters', () => {
    const w = 2.98;
    const y0 = 1.61;
    const J = Math.max(1, Math.floor(0.6 / DELTA));
    expect(J).toBe(2);
    expect(miss(y0, w)).toBeGreaterThan(0.05); // 3.10 − 3.0
    // premise: every grid candidate within reach either leaves the road or misses the band
    for (let j = -J; j <= J; j++) {
      if (j === 0) continue;
      const y = y0 + j * DELTA;
      expect(!inRoad(y, w) || miss(y, w) > 1e-3, `j = ${j}`).toBe(true);
    }
    const yStar = Math.min(W - w / 2, Math.max(w / 2, (BAND[0] + BAND[1]) / 2));
    expect(yStar).toBe(1.5);
    expect(Math.abs(yStar - y0)).toBeLessThanOrEqual(J * DELTA);
    expect(miss(yStar, w)).toBe(0);

    const tMove = Math.ceil(Math.abs(yStar - y0) / (0.25 * 0.6) / DT - 1e-9) * DT + DT;
    const bound = tMove + Math.sqrt((2 * 2) / (1 / 2)) + 2 * DT;
    const r = run(w, y0, 'strip', Math.ceil(bound / DT) + 10);
    expect(r.enteredAt, 'entered the movement').toBeGreaterThan(0);
    expect(r.enteredAt).toBeLessThanOrEqual(bound + 1e-9);
    expect(Math.abs(r.yAtEntry - yStar)).toBeLessThanOrEqual(1e-9);
    expect(miss(r.yAtEntry, w)).toBeLessThanOrEqual(1e-9);
  });

  it('unchanged when a grid candidate fits: a 2.5 m bus at y = 1.86 takes the grid position 1.61, not y*', () => {
    // body [0.61, 3.11] misses by 0.11; j = −1 → 1.61 (body [0.36, 2.86]) and j = −2 → 1.36
    // (body [0.11, 2.61]) both fit with the same incentive (bias to dist 0, obstacle gone), so
    // the tie goes to the smaller |j| (§2.4): y = 1.61. y* = 1.5 is not a candidate.
    const w = 2.5;
    expect(miss(1.86, w)).toBeGreaterThan(0.1);
    expect(miss(1.61, w)).toBe(0);
    const r = run(w, 1.86, 'strip', 300);
    expect(r.enteredAt).toBeGreaterThan(0);
    expect(Math.abs(r.yAtEntry - 1.61)).toBeLessThanOrEqual(1e-9);
    for (const y of r.ys) expect(Math.abs(y - 1.5)).toBeGreaterThan(1e-6);
  });
});

describe('lane mode is unaffected', () => {
  it('a 2.98 m bus at the lane-0 centre (1.75, body [0.26, 3.24], miss 0.24) cannot fit [0, 3] and stays', () => {
    // lane mode moves only between lane centres (1.75, 5.25, 8.75): none fits [0, 3], and there
    // is no band-centred move in lane mode, so the bus never leaves 'a' and never moves sideways
    const w = 2.98;
    expect(miss(1.75, w)).toBeGreaterThan(0.2);
    const r = run(w, 1.75, 'lane', 300);
    expect(r.enteredAt).toBe(-1);
    for (const y of r.ys) expect(y).toBe(1.75);
  });
});
