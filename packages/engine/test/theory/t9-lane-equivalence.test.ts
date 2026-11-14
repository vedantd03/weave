/**
 * T9 — lane mode with no useful lane changes behaves as independent single-lane rings
 * (docs/MODEL.md §2.4 "Lane mode reduces to MOBIL", §1.7 initial placement).
 *
 * Setup: ring, `lanes` = n, mode 'lane', jitter 0, one class with spread 0. Initial placement
 * puts vehicle k at s = k·L/N in lane k mod n, so every lane carries N/n vehicles evenly spaced
 * at Λ = n·L/N, and neighbouring lanes are offset by L/N.
 *
 * Why no lane change can happen (theory, checked in the test): with no jitter every vehicle in
 * every lane has the same speed v(t) and the same gap g = Λ − ℓ at all times (the system is
 * invariant under the shift by L/N combined with a lane rotation), so the whole trajectory is
 * the single-vehicle recursion v' = ballistic(v, a(g, v, 0)). For a change into a lane whose
 * vehicles are δ ahead (front to front) and Λ − δ behind:
 *   ã_c = a(δ − ℓ, v, 0),  a_c = a(g, v, 0),
 *   ã_N = a(Λ − δ − ℓ, v, 0), a_N = a_c,   ã_O = a(2Λ − ℓ, v, 0), a_O = a_c,
 *   Δ = (ã_c − a_c) + p((ã_N − a_N) + (ã_O − a_O)).
 * We compute max Δ over the whole trajectory and every δ that occurs, and require it to be
 * below Δa_th by a margin of 0.05 m/s² (rounding of ~1e-13 cannot bridge it). Then targetY
 * never changes and each lane is exactly the single-lane ring of T4/T5.
 */
import { describe, expect, it } from 'vitest';
import { createSim } from '../../src/sim/sim.ts';
import type { ScenarioInput } from '../../src/schema/index.ts';
import { discreteRingStability, equilibriumSpeed, idmRef, type Idm } from '../helpers/idm-theory.ts';
import { classSet } from '../helpers/m2.ts';
import type { M2Sim } from '../helpers/m2.ts';
import { ballisticRef } from '../helpers/kinematics.ts';

const P: Idm = { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 };
const LEN = 5;
const POLITENESS = 0.5;
const THRESHOLD = 0.2;
const L = 300;
const DT = 0.2;
const STEPS = 3000;
const CLASSES = classSet([
  { id: 'car', length: LEN, width: 1.8, idm: P, c0: 0.2, c1: 0, maxLat: 0.8, politeness: POLITENESS, threshold: THRESHOLD },
]);

function ring(lanes: number, densityPerKm: number): ScenarioInput {
  return {
    version: 1,
    id: 't9',
    name: 't9',
    network: { kind: 'generator', params: { generator: 'ring', circumferenceM: L, widthM: 3.5 * lanes, lanes, speedLimitMps: 40 } },
    composition: { car: 1 },
    initialDensityPerKm: densityPerKm,
    initialJitterM: 0,
    mode: 'lane',
    dtS: DT,
    durationS: 4 * 3600,
    warmupS: 0,
    seed: 5,
  };
}
const sim = (sc: ScenarioInput) => createSim({ scenario: sc, classes: CLASSES }) as unknown as M2Sim;

/** max Δ over the uniform trajectory for the lane offsets δ that occur with n lanes. */
function maxIncentive(n: number, N: number): number {
  const spacing = (n * L) / N;
  const g = spacing - LEN;
  const deltas: number[] = [];
  for (let m = 1; m < n; m++) deltas.push((m * L) / N);
  let v = 0;
  let worst = -Infinity;
  for (let k = 0; k <= STEPS; k++) {
    const ac = idmRef(P, v, g, 0);
    for (const d of deltas) {
      const aTc = idmRef(P, v, d - LEN, 0);
      const aTn = idmRef(P, v, spacing - d - LEN, 0);
      const aTo = idmRef(P, v, 2 * spacing - LEN, 0);
      worst = Math.max(worst, aTc - ac + POLITENESS * (aTn - ac + (aTo - ac)));
    }
    v = ballisticRef(0, v, ac, DT).v;
  }
  return worst;
}

for (const n of [2, 3]) {
  describe(`T9 ring with ${n} lanes in lane mode`, () => {
    const perLane = 12;
    const N = perLane * n;
    const density = (N * 1000) / L; // 80 or 120 veh/km → N = 24 or 36
    const g = (n * L) / N - LEN; // 20 m, as the single-lane ring of T4
    const ve = equilibriumSpeed(P, g);

    it('premises: no lane change is ever worth it; each lane is string stable', () => {
      expect(Math.round((density * L) / 1000)).toBe(N);
      expect(maxIncentive(n, N)).toBeLessThan(THRESHOLD - 0.05);
      const { rate } = discreteRingStability(P, ve, perLane, DT);
      expect(1e6 * P.v0 * Math.pow(rate, STEPS)).toBeLessThan(1e-6); // as T4
    });

    it('targetY never changes and every lane matches the single-lane ring step by step', () => {
      const multi = sim(ring(n, density));
      const single = sim(ring(1, (perLane * 1000) / L));
      expect(multi.vehicleCount()).toBe(N);
      expect(single.vehicleCount()).toBe(perLane);
      const y0 = new Map(multi.vehicles().map((v) => [v.id, v.y]));
      const laneCentres = new Set([...y0.values()].map((y) => y.toFixed(6)));
      expect(laneCentres.size).toBe(n);
      for (let k = 1; k <= STEPS; k++) {
        multi.advance(1);
        single.advance(1);
        const vs = multi.vehicles();
        for (const v of vs) {
          expect(v.targetY).toBe(y0.get(v.id));
          expect(v.y).toBe(y0.get(v.id));
        }
        if (k % 100 === 0) {
          // Uniform flow: all speeds equal the single-lane ring's (rounding-level differences
          // only, ≪ 1e-9 m/s since both evolve the same recursion from the same start).
          const ref = single.vehicles()[0]!.v;
          for (const v of [...vs, ...single.vehicles()]) expect(Math.abs(v.v - ref)).toBeLessThanOrEqual(1e-9);
        }
      }
      // T4: converged to the equilibrium speed of the per-lane gap
      for (const v of multi.vehicles()) expect(Math.abs(v.v - ve)).toBeLessThanOrEqual(1e-6);
    });
  });
}
