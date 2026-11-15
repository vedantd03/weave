import type { ClassSet, Network, ReplicateResult, ScenarioInput } from '@weave/engine';

export interface Job {
  scenario: ScenarioInput;
  classes: ClassSet;
  network?: Network;
  seed: number;
}

export interface Progress {
  done: number;
  total: number;
  /** Mean wall time of the completed runs (ms). */
  meanRunMs: number;
  workers: number;
}

export class Cancelled extends Error {
  constructor() {
    super('experiment cancelled');
  }
}

/** Pool of experiment workers (hardwareConcurrency − 1 by default, ?workers=N overrides). */
export class ExperimentPool {
  private workers: Worker[] = [];
  private cancel: (() => void) | null = null;

  constructor(size?: number) {
    const fromUrl = Number(new URLSearchParams(window.location.search).get('workers'));
    const n = Math.max(1, size ?? (fromUrl > 0 ? fromUrl : (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      this.workers.push(new Worker(new URL('./experiment.worker.ts', import.meta.url), { type: 'module', name: `weave-exp-${i}` }));
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Wall time (ms) to simulate probeS seconds of a scenario, in a short-lived worker of its own so
   * a probe can never interleave with a run's messages.
   */
  static probe(job: Job, probeS: number): Promise<number> {
    const w = new Worker(new URL('./experiment.worker.ts', import.meta.url), { type: 'module', name: 'weave-exp-probe' });
    return new Promise<number>((resolve, reject) => {
      w.onmessage = (ev: MessageEvent<{ ms?: number; error?: string }>) => (ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.ms!));
      w.onerror = (e) => reject(new Error(e.message || 'experiment worker failed'));
      w.postMessage({ job: -1, scenario: job.scenario, classes: job.classes, network: job.network, seed: job.seed, probeS });
    }).finally(() => w.terminate());
  }

  /** Run all jobs; results come back in job order regardless of completion order. */
  run(jobs: Job[], onProgress: (p: Progress) => void): Promise<ReplicateResult[]> {
    const results: ReplicateResult[] = new Array(jobs.length);
    let next = 0;
    let done = 0;
    let totalMs = 0;
    return new Promise((resolve, reject) => {
      this.cancel = () => reject(new Cancelled());
      if (jobs.length === 0) return resolve([]);
      const feed = (w: Worker) => {
        if (next >= jobs.length) return;
        const job = next++;
        const j = jobs[job]!;
        w.postMessage({ job, scenario: j.scenario, classes: j.classes, network: j.network, seed: j.seed });
      };
      for (const w of this.workers) {
        w.onmessage = (ev: MessageEvent<{ job: number; result?: ReplicateResult; error?: string; ms?: number }>) => {
          if (ev.data.error) return reject(new Error(ev.data.error));
          results[ev.data.job] = ev.data.result!;
          done++;
          totalMs += ev.data.ms ?? 0;
          onProgress({ done, total: jobs.length, meanRunMs: totalMs / done, workers: this.workers.length });
          if (done === jobs.length) {
            this.cancel = null;
            resolve(results);
          } else feed(w);
        };
        w.onerror = (e) => reject(new Error(e.message || 'experiment worker failed'));
        feed(w);
      }
    });
  }

  /** Stop all work now: the pending run rejects with Cancelled and the workers are gone. */
  abort(): void {
    this.cancel?.();
    this.cancel = null;
    this.terminate();
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
