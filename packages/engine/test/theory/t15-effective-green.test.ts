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
import { classSet, linkStat, makeSim } from '../helpers/m2.ts';
import { ARM, armLinks, junctionScenario } from '../helpers/m3.ts';

const LEN = 600;
const arms = [ARM(0, 3.5, 1, LEN), ARM(90, 3.5, 1, LEN), ARM(180, 3.5, 1, LEN), ARM(270, 3.5, 1, LEN)];
const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);
const DT = 0.2;
const K = 10;
const WARM = 900;
const E = 1 + 0.2;
const GREENS = [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60];
const log = (line: string) => (globalThis as unknown as { console: { log(s: string): void } }).console.log(line);

function perCycle(g: number): { mean: number; counts: number[]; minQueueEndGreen: number; minQueueBoundary: number } {
  const base = makeSim(junctionScenario({ arms }), classes).network;
  const links = armLinks(base);
  const order = [...links.keys()].sort((x, y) => x - y);
  const a0 = links.get(order[0]!)!;
  const a2 = links.get(order[2]!)!;
  const from = (l: string) => base.movements.filter((m) => m.fromLink === l).map((m) => m.id);
  const through = base.movements.find((m) => m.fromLink === a0.inLink && m.toLink === a2.outLink)!.id;
  const node = base.signals[0]!.node;
  const sim = makeSim(
    junctionScenario({
      arms,
      od: [{ origin: `arm${order[0]}_in`, destination: `arm${order[2]}_out`, rateVph: 3000 }],
      signalOverrides: [
        { node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: g, protected: from(a0.inLink) }, { greenS: 10, protected: from(a2.inLink) }] },
      ],
    }),
    classes,
  );
  const C = g + 20;
  const perC = Math.round(C / DT);
  const greenSteps = Math.round(g / DT); // phase A green is [0, g) in every cycle (offset 0)
  sim.advance(perC * Math.ceil(WARM / C));
  const queued = () => sim.vehicles().filter((v) => v.link === a0.inLink && v.v < 0.5).length;
  const counts: number[] = [];
  let minQueueEndGreen = Infinity;
  let minQueueBoundary = Infinity;
  for (let k = 0; k < K; k++) {
    minQueueBoundary = Math.min(minQueueBoundary, queued());
    const e0 = linkStat(sim, through).entered;
    sim.advance(greenSteps - 1); // last step of green: t = start + g − dt
    minQueueEndGreen = Math.min(minQueueEndGreen, queued());
    sim.advance(perC - greenSteps + 1);
    counts.push(linkStat(sim, through).entered - e0);
  }
  return { mean: counts.reduce((a, b) => a + b, 0) / K, counts, minQueueEndGreen, minQueueBoundary };
}

/** least-squares line and the residual bound factors κ_i = |1 − H_ii| + Σ_{j≠i} |H_ij| */
function fit(x: number[], y: number[]) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - mx) * (v - mx), 0);
  const slope = x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0) / sxx;
  const icpt = my - slope * mx;
  const H = (i: number, j: number) => 1 / n + ((x[i]! - mx) * (x[j]! - mx)) / sxx;
  const kappa = x.map((_, i) => x.reduce((a, _v, j) => a + (j === i ? Math.abs(1 - H(i, i)) : Math.abs(H(i, j))), 0));
  return { slope, icpt, kappa };
}

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
