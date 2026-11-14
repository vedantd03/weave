/**
 * T5 — fundamental diagram on the ring. For several densities in the string-stable range the
 * measured flow Q = ρ·mean(v) after convergence must equal the IDM equilibrium flow
 * Q_e(ρ) = ρ·v_e(ρ), where s_e(v_e) = 1/ρ − ℓ (MODEL.md §1.3; Treiber & Kesting 2013, ch. 11
 * "steady-state" FD). ρ = N/L with N = round(density·L/1000) (MODEL.md §1.7).
 */
import { describe, expect, it } from 'vitest';
import { createSim } from '../../src/sim/sim.ts';
import { discreteRingStability, equilibriumSpeed, stringStabilityMargin, type Idm } from '../helpers/idm-theory.ts';
import { ringClassSet, ringCount, ringScenario } from '../helpers/ring.ts';
import { mean } from '../helpers/numeric.ts';

const P: Idm = { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 };
const LEN = 5;
const L = 200;
const DT = 0.2;
/** Speed tolerance and transient factor: same derivation as T4 (K·v0·rate^n ≤ TOL_V). */
const TOL_V = 1e-6;
const K = 1e6;
const MAX_STEPS = 8000;

describe('T5 fundamental diagram, ring road', () => {
  // veh/km → N = 5, 6, 8, 10, 12, 14: both sides of the capacity point (Q_e peaks near 50 veh/km)
  const densities = [25, 30, 40, 50, 60, 70];

  for (const density of densities) {
    const N = ringCount(density, L);
    const rho = N / L; // veh/m, the density actually simulated
    const ve = equilibriumSpeed(P, 1 / rho - LEN);
    const Qe = rho * ve; // veh/s

    it(`ρ = ${density} veh/km: Q = ρ·mean(v) matches ρ·v_e(ρ) = ${(Qe * 3600).toFixed(1)} veh/h`, () => {
      // Premise: this density is in the stable range, and the run is long enough.
      expect(stringStabilityMargin(P, ve)).toBeGreaterThan(0);
      const { rate } = discreteRingStability(P, ve, N, DT);
      expect(rate).toBeLessThan(1);
      const steps = Math.max(1500, Math.ceil(Math.log(TOL_V / (K * P.v0)) / Math.log(rate)));
      expect(steps).toBeLessThanOrEqual(MAX_STEPS);

      const sim = createSim({
        scenario: ringScenario({ circumferenceM: L, densityPerKm: density, jitterM: 1, seed: 11 }),
        classes: ringClassSet(P, LEN),
      });
      expect(sim.vehicleCount()).toBe(N);
      sim.advance(steps);
      const Q = rho * mean(sim.vehicles().map((v) => v.v));
      // |mean(v) − v_e| ≤ TOL_V ⇒ |Q − Q_e| ≤ ρ·TOL_V.
      expect(Math.abs(Q - Qe)).toBeLessThanOrEqual(rho * TOL_V);
    });
  }

  it('the equilibrium FD from the test helper is physically sensible (guards the oracle)', () => {
    // v_e decreasing in density, and Q_e(ρ) → ρ·v0-ish at low density.
    let prev = Infinity;
    for (const density of densities) {
      const N = ringCount(density, L);
      const ve = equilibriumSpeed(P, L / N - LEN);
      expect(ve).toBeLessThan(prev);
      expect(ve).toBeGreaterThan(0);
      expect(ve).toBeLessThan(P.v0);
      prev = ve;
    }
  });
});
