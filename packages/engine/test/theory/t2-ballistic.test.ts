/**
 * T2 — ballistic integration with the stop condition (docs/MODEL.md §1.4;
 * Treiber & Kanagaraj, 2015, "Comparing numerical integration schemes for time-continuous
 * car-following models", Physica A 419). Expected values are exact constant-acceleration
 * kinematics written out in the test.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ballistic } from '../../src/models/integrate.ts';
import { EPS } from '../helpers/numeric.ts';

/**
 * x' = x + v·dt + ½·a·dt² evaluated in any reasonable operation order: each of the three terms
 * is formed with ≤ 3 roundings and the two additions add 2 more, so the error is at most
 * ~5 half-ulps of the largest magnitude involved. We allow 4·EPS·(|x| + |v·dt| + |½a·dt²|),
 * i.e. 8 half-ulps.
 */
const xTol = (x: number, v: number, a: number, dt: number) =>
  4 * EPS * (Math.abs(x) + Math.abs(v * dt) + Math.abs(0.5 * a * dt * dt)) + Number.MIN_VALUE;
/** v' = v + a·dt: two roundings → 2·EPS·(|v| + |a·dt|). */
const vTol = (v: number, a: number, dt: number) => 2 * EPS * (Math.abs(v) + Math.abs(a * dt)) + Number.MIN_VALUE;

describe('T2 ballistic update (MODEL.md §1.4)', () => {
  it('normal step: exact constant-acceleration kinematics', () => {
    const cases: [number, number, number, number][] = [
      [0, 10, 0, 0.2], // cruising: x' = 2, v' = 10
      [5, 10, 1.5, 0.2],
      [100, 0, 2, 0.2], // start from rest: x' = 100 + 0.04, v' = 0.4
      [42, 12, -3, 0.2], // braking, v + a·dt = 11.4 ≥ 0
      [0, 3, -9, 0.2], // v + a·dt = 1.2 ≥ 0
      [1234.5, 20, 0.7, 0.5],
    ];
    for (const [x, v, a, dt] of cases) {
      const r = ballistic(x, v, a, dt);
      expect(Math.abs(r.x - (x + v * dt + 0.5 * a * dt * dt))).toBeLessThanOrEqual(xTol(x, v, a, dt));
      expect(Math.abs(r.v - (v + a * dt))).toBeLessThanOrEqual(vTol(v, a, dt));
    }
    // Dyadic inputs make every operation exact, so equality is required here.
    expect(ballistic(0, 10, 0, 0.25)).toEqual({ x: 2.5, v: 10 });
    expect(ballistic(8, 4, -2, 0.5)).toEqual({ x: 8 + 2 - 0.25, v: 3 });
  });

  it('stopping within the step: x′ = x − v²/(2a), v′ = 0', () => {
    // v = 10, a = −9, dt = 2: v + a·dt = −8 < 0 → stops after v/|a| = 1.11 s, having
    // travelled v²/(2|a|) = 100/18 = 5.5556 m (not v·dt + ½a·dt² = 2 m, which would reverse).
    const cases: [number, number, number, number][] = [
      [0, 10, -9, 2],
      [50, 1, -9, 0.2], // v + a·dt = −0.8
      [7, 0.3, -2, 0.2], // v + a·dt = −0.1
      [3, 5, -40, 0.2],
    ];
    for (const [x, v, a, dt] of cases) {
      expect(v + a * dt).toBeLessThan(0);
      const r = ballistic(x, v, a, dt);
      expect(Math.abs(r.v)).toBe(0); // +0 (or −0) exactly
      // x − v²/(2a): three roundings plus the addition → 4 half-ulps of max(|x|, v²/(2|a|)).
      const d = (v * v) / (2 * -a);
      expect(Math.abs(r.x - (x + d))).toBeLessThanOrEqual(4 * EPS * (Math.abs(x) + d));
    }
  });

  it('a vehicle at rest with a < 0 stays put (no reversing)', () => {
    for (const a of [-0.1, -2, -9]) {
      const r = ballistic(17.25, 0, a, 0.2);
      expect(Math.abs(r.v)).toBe(0); // +0 (or −0) exactly
      expect(r.x).toBe(17.25);
    }
  });

  it('the two branches agree at the switching point v + a·dt = 0', () => {
    // Normal formula at v = −a·dt: x + v·dt − ½ v·dt = x + v·dt/2; stop formula:
    // x − v²/(2a) = x + v·dt/2. Continuity ⇒ both sides of the switch are within the dt error.
    const x = 10;
    const dt = 0.2;
    const a = -5;
    const v = -a * dt; // 1
    const at = ballistic(x, v, a, dt);
    expect(at.v).toBeCloseTo(0, 15);
    expect(Math.abs(at.x - (x + (v * dt) / 2))).toBeLessThanOrEqual(xTol(x, v, a, dt));
    const justBelow = ballistic(x, v * (1 - 1e-9), a, dt); // stop branch
    const justAbove = ballistic(x, v * (1 + 1e-9), a, dt); // normal branch
    // Position is continuous with slope ≤ dt in v, so a 1e-9 relative change in v moves x by ≤ 1e-9·v·dt.
    expect(Math.abs(justBelow.x - at.x)).toBeLessThanOrEqual(2e-9 * v * dt + xTol(x, v, a, dt));
    expect(Math.abs(justAbove.x - at.x)).toBeLessThanOrEqual(2e-9 * v * dt + xTol(x, v, a, dt));
    expect(Math.abs(justBelow.v)).toBe(0);
  });

  it('property: never reverses, v′ ≥ 0, displacement bounded by kinematics, formula per branch', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        fc.double({ min: -20, max: 10, noNaN: true }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (x, v, a, dt) => {
          const r = ballistic(x, v, a, dt);
          expect(r.v).toBeGreaterThanOrEqual(0);
          expect(r.x).toBeGreaterThanOrEqual(x); // never moves backwards
          if (v + a * dt >= 0) {
            expect(Math.abs(r.x - (x + v * dt + 0.5 * a * dt * dt))).toBeLessThanOrEqual(xTol(x, v, a, dt));
            expect(Math.abs(r.v - (v + a * dt))).toBeLessThanOrEqual(vTol(v, a, dt));
          } else {
            expect(Math.abs(r.v)).toBe(0); // +0 (or −0) exactly
            const d = (v * v) / (2 * -a);
            expect(Math.abs(r.x - (x + d))).toBeLessThanOrEqual(4 * EPS * (Math.abs(x) + d) + Number.MIN_VALUE);
            // Stopping inside the step means v < |a|·dt, so the distance v²/(2|a|) < v·dt/2.
            expect(r.x - x).toBeLessThanOrEqual((v * dt) / 2 + xTol(x, v, a, dt));
          }
        },
      ),
      { seed: 20261114, numRuns: 5000 },
    );
  });
});
