import type { SignalPlan } from '../schema/network.ts';
import type { ScenarioInput } from '../schema/scenario.ts';
import { createSim, type SimInput } from '../sim/sim.ts';

/** Webster green allocation and the retimed-flyover variant (docs/MODEL.md §5.3). */

const MIN_GREEN_S = 5;
/** HCM base saturation flow, per 3.5 m of movement width (assumption). */
const SAT_PER_35 = 1800;

export function retimeWebster(plan: SignalPlan, criticalFlowRatio: Record<string, number>): SignalPlan {
  const lost = plan.amberS + plan.allRedS;
  const C = plan.phases.reduce((a, p) => a + p.greenS + lost, 0);
  const G = C - plan.phases.length * lost;
  const y = plan.phases.map((p) => Math.max(0, ...[...p.protected, ...p.permissive].map((m) => criticalFlowRatio[m] ?? 0)));
  const Y = y.reduce((a, b) => a + b, 0);
  const n = plan.phases.length;
  let g: number[];
  if (!(Y > 0)) {
    g = new Array(n).fill(G / n);
  } else {
    // Proportional to y with 5 s minima: fix phases below the minimum, rescale the rest.
    const fixed = new Array(n).fill(false);
    for (;;) {
      const free = y.map((v, i) => (fixed[i] ? 0 : v));
      const Yf = free.reduce((a, b) => a + b, 0);
      const left = G - fixed.filter(Boolean).length * MIN_GREEN_S;
      g = y.map((v, i) => (fixed[i] ? MIN_GREEN_S : Yf > 0 ? (left * v) / Yf : left / Math.max(1, n - fixed.filter(Boolean).length)));
      const low = g.findIndex((v, i) => !fixed[i] && v < MIN_GREEN_S - 1e-12);
      if (low < 0) break;
      for (let i = 0; i < n; i++) if (!fixed[i] && g[i]! < MIN_GREEN_S - 1e-12) fixed[i] = true;
    }
  }
  return { ...plan, phases: plan.phases.map((p, i) => ({ ...p, greenS: g[i]! })) };
}

/** q_m / s_m for every movement: OD demand routed through m over its saturation flow. */
export function criticalFlowRatios(input: SimInput): Record<string, number> {
  const sim = createSim(input);
  const q: Record<string, number> = {};
  for (const m of sim.network.movements) q[m.id] = 0;
  for (const r of sim.odRoutes()) for (const seg of r.segments) if (seg in q) q[seg]! += r.rateVph;
  const out: Record<string, number> = {};
  for (const m of sim.network.movements) out[m.id] = q[m.id]! / ((SAT_PER_35 * m.widthM) / 3.5);
  return out;
}

/** The input scenario with every signal plan of its network retimed by Webster's rule. */
export function retimedFlyoverScenario(input: SimInput): ScenarioInput {
  const sim = createSim(input);
  const ratios = criticalFlowRatios(input);
  return { ...input.scenario, signalOverrides: sim.network.signals.map((p) => retimeWebster(p, ratios)) };
}
