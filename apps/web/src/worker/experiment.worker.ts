/// <reference lib="webworker" />
import { ClassSet, Network, Scenario, runReplicate } from '@weave/engine';

/**
 * Experiment worker: runs one replicate per request (docs/MODEL.md §5.4). Inputs are
 * zod-validated at the boundary. Replicates are independent and deterministic, so results do
 * not depend on which worker ran them or in which order.
 */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<{ job: number; scenario: unknown; classes: unknown; network?: unknown; seed: number }>) => {
  const { job, seed } = ev.data;
  try {
    const scenario = Scenario.parse(ev.data.scenario);
    const classes = ClassSet.parse(ev.data.classes);
    const network = ev.data.network ? Network.parse(ev.data.network) : undefined;
    const result = runReplicate({ scenario, classes, ...(network ? { network } : {}) }, seed);
    self.postMessage({ job, result });
  } catch (e) {
    self.postMessage({ job, error: e instanceof Error ? e.message : String(e) });
  }
};
