/**
 * T15 — effective green (Webster 1958; HCM): with a permanently saturated approach, the number
 * of vehicles discharged per cycle is s·(g + A − l), i.e. affine in the displayed green g
 * (s = saturation flow, A = amber used, l = lost time). We run a generated 4-arm signalised
 * junction (one lane per arm, lane mode) with an override plan
 *   phase A: arm 0's movements, green g;  phase B: arm 2's movements, green 10 s;
 *   amber 3 s, all-red 2 s  ⇒ C = g + 20 s,
 * saturate arm 0 → arm 2 (3000 veh/h ≫ capacity), and count entries into that movement per
 * cycle (linkStats, §2.8) over K = 20 cycles after a ≥ 600 s warm-up, for g = 20, 30, 40, 50 s.
 *
 * Tolerance on collinearity: each per-cycle mean is an integer count over K aligned cycles, so
 * it is within 1/K of the long-run per-cycle throughput (a periodic discharge's running count
 * stays within one vehicle of rate·time). The residual of the two middle points from the line
 * through the outer two combines four such errors with weights ≤ 1 + 2/3 + 1/3 → ≤ 2/K = 0.1,
 * plus 0.2 veh/cycle for discharge headways not fully converged at the start of green.
 */
import { describe, expect, it } from 'vitest';
import { classSet, linkStat, makeSim } from '../helpers/m2.ts';
import { ARM, armLinks, junctionScenario } from '../helpers/m3.ts';

const arms = [ARM(0, 3.5, 1, 300), ARM(90, 3.5, 1, 300), ARM(180, 3.5, 1, 300), ARM(270, 3.5, 1, 300)];
const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);
const DT = 0.2;
const K = 20;

function perCycle(g: number): number {
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
      signalOverrides: [{ node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: g, protected: from(a0.inLink) }, { greenS: 10, protected: from(a2.inLink) }] }],
    }),
    classes,
  );
  const C = g + 20;
  const perC = Math.round(C / DT);
  sim.advance(perC * Math.ceil(600 / C));
  const e0 = linkStat(sim, through).entered;
  for (let k = 0; k < K; k++) {
    sim.advance(perC);
    // saturation premise: a standing queue remains on the approach at every cycle boundary
    const queued = sim.vehicles().filter((v) => v.link === a0.inLink && v.v < 0.5).length;
    expect(queued).toBeGreaterThanOrEqual(3);
  }
  return (linkStat(sim, through).entered - e0) / K;
}

describe('T15 saturated throughput per cycle is affine in the green time', () => {
  it('collinear over four splits; positive slope', () => {
    const gs = [20, 30, 40, 50];
    const n = gs.map(perCycle);
    const slope = (n[3]! - n[0]!) / (gs[3]! - gs[0]!);
    expect(slope).toBeGreaterThan(0.1); // veh/s of green: a real saturation flow
    for (const j of [1, 2]) {
      const onLine = n[0]! + slope * (gs[j]! - gs[0]!);
      expect(Math.abs(n[j]! - onLine), `g = ${gs[j]}: ${n.join(', ')}`).toBeLessThanOrEqual(2 / K + 0.2);
    }
  });
});
