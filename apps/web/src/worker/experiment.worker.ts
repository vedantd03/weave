/// <reference lib="webworker" />
import { ClassSet, createSim, Network, Scenario, runReplicate } from '@weave/engine';

/**
 * Experiment worker: runs one replicate per request (docs/MODEL.md §5.4, §7.4), or a timing
 * probe for the pre-run estimate. Inputs are zod-validated at the boundary. Replicates are
 * independent and deterministic, so results do not depend on which worker ran them.
 */
declare const self: DedicatedWorkerGlobalScope;

type Req = { job: number; scenario: unknown; classes: unknown; network?: unknown; seed: number; probeS?: number };

self.onmessage = (ev: MessageEvent<Req>) => {
  const { job, seed } = ev.data;
  try {
    const scenario = Scenario.parse(ev.data.scenario);
    const classes = ClassSet.parse(ev.data.classes);
    const network = ev.data.network ? Network.parse(ev.data.network) : undefined;
    const t0 = performance.now();
    if (ev.data.probeS) {
      // Timing probe: simulate probeS seconds of this scenario and report the wall time.
      const sim = createSim({ scenario: { ...scenario, seed }, classes, ...(network ? { network } : {}) });
      sim.advance(Math.round(ev.data.probeS / sim.dt));
      self.postMessage({ job, ms: performance.now() - t0 });
      return;
    }
    const result = runReplicate({ scenario, classes, ...(network ? { network } : {}) }, seed);
    self.postMessage({ job, result, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ job, error: e instanceof Error ? e.message : String(e) });
  }
};
