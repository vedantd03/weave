/**
 * T15 — effective green (Webster 1958; HCM): with a permanently saturated approach, the number
 * of vehicles discharged per cycle is N(g) = s·(g + A − l), affine in the displayed green g
 * (s = saturation flow, A = amber used, l = lost time).
 *
 * Setup: generated 4-arm signalised junction, one lane per arm, lane mode, 600 m arms. Override
 * plan: phase A = arm 0's movements, green g; phase B = arm 2's movements, green 10 s; amber 3 s,
 * all-red 2 s ⇒ C = g + 20 s. Demand arm 0 → arm 2 at 3000 veh/h (≫ capacity) keeps the
 * approach full. For g = 20, 24, …, 60 s we count entries into the through movement per cycle
 * (linkStats, §2.8) over K = 10 cycles aligned to the plan, after a 900 s warm-up.
 *
 * Premise (Webster's saturation assumption), checked for every cycle: a standing queue
 * (≥ 3 vehicles at < 0.5 m/s on the approach) exists at the cycle boundary AND at the end of
 * green (the last step before amber). If the queue empties during green the premise fails
 * visibly instead of showing up as curvature.
 *
 * Tolerance. Discharge is phase-locked to the cycle: each cycle releases the same integer
 * number of vehicles, or alternates between two. So each per-cycle mean lies within
 * e = 1 vehicle of the continuous affine model, plus 0.2 veh/cycle for start-up headways not yet
 * converged: e = 1.2. Fitting the line by least squares, residual i is r_i = ε_i − Σ_j H_ij ε_j
 * (H the hat matrix of the design), so |r_i| ≤ e·κ_i with κ_i = |1 − H_ii| + Σ_{j≠i} |H_ij|,
 * computed in the test from the green times alone.
 */
import { describe, expect, it } from 'vitest';
import { E, GREENS, fit, log, perCycle } from '../helpers/signal-discharge.ts';

describe('T15 saturated throughput per cycle is affine in the green time', () => {
  it('least-squares fit over g = 20…60 s: every residual within e·κ_i; premise holds at end of green', { timeout: 180_000 }, () => {
    const runs = GREENS.map(perCycle);
    for (const [i, r] of runs.entries()) {
      expect(r.minQueueBoundary, `g = ${GREENS[i]}: standing queue at the cycle boundary`).toBeGreaterThanOrEqual(3);
      expect(r.minQueueEndGreen, `g = ${GREENS[i]}: standing queue at the end of green`).toBeGreaterThanOrEqual(3);
    }
    const y = runs.map((r) => r.mean);
    const { slope, icpt, kappa } = fit(GREENS, y);
    const resid = y.map((v, i) => v - (icpt + slope * GREENS[i]!));
    log(
      `T15_FIT slope=${slope.toFixed(4)} veh/s intercept=${icpt.toFixed(3)} ` +
        GREENS.map((g, i) => `g${g}:mean=${y[i]!.toFixed(2)},res=${resid[i]!.toFixed(3)},bound=${(E * kappa[i]!).toFixed(3)},counts=${runs[i]!.counts.join('/')},qEndGreen=${runs[i]!.minQueueEndGreen}`).join(' '),
    );
    expect(slope).toBeGreaterThan(0.1); // a real saturation flow (veh/s of green)
    resid.forEach((r, i) => expect(Math.abs(r), `g = ${GREENS[i]}`).toBeLessThanOrEqual(E * kappa[i]!));
  });
});
