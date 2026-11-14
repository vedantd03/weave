/**
 * T4 — ring road: convergence to the IDM equilibrium when string stable, stop-and-go when
 * string unstable. Runs the full simulation (createSim, MODEL.md §1.7) on the 'ring'
 * generator with one vehicle class (fixed size, spread 0).
 *
 * Expected values:
 *  - N = round(density · L / 1000) (MODEL.md §1.7), uniform net gap g = L/N − ℓ.
 *  - v_e solves s_e(v_e) = g with s_e(v) = (s0 + vT)/√(1 − (v/v0)^4) (MODEL.md §1.3), by
 *    bisection in the test helper.
 *  - Stability: S = a_v²/2 + a_v·a_dv − a_s > 0 (Wilson & Ward 2011; Treiber & Kesting 2013,
 *    ch. 15; sign convention re-derived in test/helpers/idm-theory.ts for dv = v − v_leader),
 *    plus the exact spectral radius of the linearised *discrete* ring (finite N, dt = 0.2 s,
 *    ballistic update), which is what actually governs the simulated system.
 */
import { describe, expect, it } from 'vitest';
import { createSim } from '../../src/sim/sim.ts';
import {
  discreteRingStability,
  equilibriumSpeed,
  idmPartials,
  stringStabilityMargin,
  type Idm,
} from '../helpers/idm-theory.ts';
import { ringClassSet, ringCount, ringScenario } from '../helpers/ring.ts';
import { mean, stdDev, wrap } from '../helpers/numeric.ts';

const LEN = 5; // vehicle length ℓ (m)
const DT = 0.2;

/** Gaps (front of leader's rear minus own front) on a single-file ring, from vehicle positions. */
function ringGaps(s: number[], L: number, len: number): number[] {
  const sorted = s.map((x) => wrap(x, L)).sort((a, b) => a - b);
  return sorted.map((x, i) => {
    const next = sorted[(i + 1) % sorted.length]!;
    return wrap(next - x, L) - len;
  });
}

describe('T4 ring road, string-stable IDM', () => {
  const P: Idm = { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 };
  const L = 300;
  const DENSITY = 40; // veh/km
  const N = ringCount(DENSITY, L); // 12
  const g = L / N - LEN; // 20 m
  const ve = equilibriumSpeed(P, g); // ≈ 11.64 m/s

  /**
   * Convergence tolerance. In the linear regime every speed deviation decays at least like
   * rate^n, rate = max(|1 + dt·a_v|, spectral radius over the ring modes) (helper). The initial
   * deviation is ≤ v0 (everyone starts at rest), and we allow a factor K = 1e6 for transient
   * (non-normal) amplification and the nonlinear start-up. The run length is chosen so that
   * K·v0·rate^n ≤ TOL; TOL = 1e-6 m/s is still ≥ 1e5 × the rounding noise of v (≈ 1e-14·v).
   */
  const TOL = 1e-6;
  const K = 1e6;
  const STEPS = 3000; // 600 s

  it('premises: chosen parameters are string stable with a clear margin', () => {
    expect(N).toBe(12);
    const S = stringStabilityMargin(P, ve);
    const { as } = idmPartials(P, ve);
    // margin: S is ≥ 50% of a_s, the term it must beat
    expect(S).toBeGreaterThan(0.5 * as);
    const d = discreteRingStability(P, ve, N, DT);
    expect(d.maxRingRadius).toBeLessThan(0.99);
    expect(d.uniformFactor).toBeLessThan(0.95);
    expect(K * P.v0 * Math.pow(d.rate, STEPS)).toBeLessThan(TOL);
  });

  for (const seed of [1, 7]) {
    it(`all speeds converge to v_e and all gaps to L/N − ℓ (seed ${seed})`, () => {
      const sim = createSim({
        scenario: ringScenario({ circumferenceM: L, densityPerKm: DENSITY, jitterM: 1, seed }),
        classes: ringClassSet(P, LEN),
      });
      expect(sim.vehicleCount()).toBe(N);
      expect(sim.dt).toBe(DT);
      for (const v of sim.vehicles()) {
        expect(v.v).toBe(0); // initial speed is 0 (MODEL.md §1.7)
        expect(v.length).toBe(LEN);
      }
      sim.advance(STEPS);
      expect(sim.step).toBe(STEPS);
      const vs = sim.vehicles();
      expect(vs.length).toBe(N);
      for (const v of vs) expect(Math.abs(v.v - ve)).toBeLessThanOrEqual(TOL);
      // Equal speeds in steady state ⇒ equal gaps; the same decay bound applies to the gap
      // deviation (initially ≤ 2·jitter = 2 m < v0·(1 s), so K·v0·rate^n covers it).
      for (const gap of ringGaps(vs.map((v) => v.s), L, LEN)) {
        expect(Math.abs(gap - g)).toBeLessThanOrEqual(TOL);
      }
    });
  }
});

describe('T4 ring road, string-unstable IDM', () => {
  // Small a and short T make IDM string unstable at intermediate density (Treiber & Kesting
  // 2013, ch. 11/15). v0 = 20 m/s stays below the ring's speed limit.
  const P: Idm = { v0: 20, T: 1.0, s0: 2, a: 0.3, b: 3 };
  const L = 500;
  const DENSITY = 50;
  const N = ringCount(DENSITY, L); // 25
  const g = L / N - LEN; // 15 m
  const ve = equilibriumSpeed(P, g); // ≈ 12.0 m/s
  const STEPS = 4000; // 800 s

  it('premises: the criterion is clearly violated, also for finite N and dt = 0.2 s', () => {
    expect(N).toBe(25);
    const S = stringStabilityMargin(P, ve);
    const { as } = idmPartials(P, ve);
    expect(S).toBeLessThan(-0.5 * as); // violated by more than half of a_s
    const d = discreteRingStability(P, ve, N, DT);
    // Discrete growth per step R > 1.004. Linear growth from a conservative initial
    // per-mode speed perturbation δ0 = 1e-3 m/s (a 1 m jitter gives a gap perturbation of
    // ~0.6 m std, i.e. ~0.16 m per Fourier mode, which induces speed perturbations well above
    // 1e-3 m/s within a few seconds) over STEPS steps reaches δ0·R^STEPS ≥ 1e5 m/s ≫ v0:
    // the instability must saturate nonlinearly (speeds are confined to [0, v0]) well within
    // the run.
    expect(d.maxRingRadius).toBeGreaterThan(1.004);
    expect(1e-3 * Math.pow(d.maxRingRadius, STEPS)).toBeGreaterThan(1e5);
  });

  it('develops stop-and-go waves', () => {
    const sim = createSim({
      scenario: ringScenario({ circumferenceM: L, densityPerKm: DENSITY, jitterM: 1, seed: 3 }),
      classes: ringClassSet(P, LEN),
    });
    expect(sim.vehicleCount()).toBe(N);
    sim.advance(STEPS);
    const speeds = sim.vehicles().map((v) => v.v);
    // In the stable regime the speed spread decays to ~0 (previous block). A saturated
    // stop-and-go wave splits the ring into a jam (v ≈ 0) and an outflow region near the
    // free-flow branch, so the across-vehicle speed std-dev is a sizeable fraction of v_e
    // (for a jam fraction f, std ≈ v_out·√(f(1 − f)), ≥ 0.3·v_out for 0.1 ≤ f ≤ 0.9).
    // Threshold 0.2·v_e ≈ 2.4 m/s: unreachable by a decaying perturbation, comfortably
    // below a saturated wave.
    expect(stdDev(speeds)).toBeGreaterThan(0.2 * ve);
    // and some vehicles are well into the "stop" part of stop-and-go
    expect(Math.min(...speeds)).toBeLessThan(0.5 * ve);
    // No vehicle exceeds v0 (free-road term ≤ 0 above v0) and none reverses.
    for (const v of speeds) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(P.v0 + 1e-9);
    }
    expect(mean(speeds)).toBeGreaterThan(0); // not gridlocked
  });
});
