import { createSim } from './sim/sim.ts';
import { defaultClasses } from './scenarios/defaultClasses.ts';
import { RunExport } from './schema/export.ts';
import type { Network } from './schema/network.ts';

/**
 * Rebuild a run from its export (docs/MODEL.md §6.4): the scenario as run, the default classes
 * and `manifest.steps` steps. The classes-hash check is the CLI's job (it needs SHA-256).
 */
export function replayExport(run: unknown, network?: Network): { stateHash: string; expected: string; match: boolean; simulatedTimeS: number } {
  const r = RunExport.parse(run);
  const sim = createSim({ scenario: r.scenario, classes: defaultClasses(), ...(network ? { network } : {}) });
  sim.advance(r.manifest.steps);
  const stateHash = sim.stateHash();
  return { stateHash, expected: r.manifest.finalStateHash, match: stateHash === r.manifest.finalStateHash, simulatedTimeS: sim.t };
}
