import type { SignalPlan } from '../schema/network.ts';

/** Signal colours (docs/MODEL.md §3.2); NONE marks movements that are not signal-controlled. */
export const SIG = { RED: 0, AMBER: 1, GREEN: 2, PERMISSIVE: 3, NONE: 255 } as const;
export type SigState = 0 | 1 | 2 | 3;

export function cycleLength(plan: SignalPlan): number {
  let c = 0;
  for (const p of plan.phases) c += p.greenS + plan.amberS + plan.allRedS;
  return c;
}

function phaseState(plan: SignalPlan, i: number, id: string): SigState {
  const p = plan.phases[i]!;
  if (p.protected.includes(id)) return SIG.GREEN;
  if (p.permissive.includes(id)) return SIG.PERMISSIVE;
  return SIG.RED;
}

/** Colour of a movement at time t under a plan (§3.2). */
export function signalState(plan: SignalPlan, movementId: string, t: number): SigState {
  const C = cycleLength(plan);
  if (!(C > 0)) return SIG.RED;
  let tau = (t - plan.offsetS) % C;
  if (tau < 0) tau += C;
  let start = 0;
  const n = plan.phases.length;
  for (let i = 0; i < n; i++) {
    const p = plan.phases[i]!;
    const gEnd = start + p.greenS;
    const aEnd = gEnd + plan.amberS;
    const rEnd = aEnd + plan.allRedS;
    if (tau < gEnd) return phaseState(plan, i, movementId);
    if (tau < rEnd) {
      const now = phaseState(plan, i, movementId);
      if (now === SIG.RED) return SIG.RED;
      const next = phaseState(plan, (i + 1) % n, movementId);
      if (next !== SIG.RED) return now; // continuity into the next phase
      return tau < aEnd ? SIG.AMBER : SIG.RED;
    }
    start = rEnd;
  }
  return SIG.RED;
}
