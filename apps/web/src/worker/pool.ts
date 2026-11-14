import type { ClassSet, Network, ReplicateResult, ScenarioInput } from '@weave/engine';

export interface Job {
  scenario: ScenarioInput;
  classes: ClassSet;
  network?: Network;
  seed: number;
}

/** Pool of experiment workers (hardwareConcurrency − 1 by default, ?workers=N overrides). */
export class ExperimentPool {
  private workers: Worker[] = [];

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

  /** Run all jobs; results come back in job order regardless of completion order. */
  run(jobs: Job[], onProgress: (done: number, total: number) => void): Promise<ReplicateResult[]> {
    const results: ReplicateResult[] = new Array(jobs.length);
    let next = 0;
    let done = 0;
    return new Promise((resolve, reject) => {
      if (jobs.length === 0) return resolve([]);
      const feed = (w: Worker) => {
        if (next >= jobs.length) return;
        const job = next++;
        const j = jobs[job]!;
        w.postMessage({ job, scenario: j.scenario, classes: j.classes, network: j.network, seed: j.seed });
      };
      for (const w of this.workers) {
        w.onmessage = (ev: MessageEvent<{ job: number; result?: ReplicateResult; error?: string }>) => {
          if (ev.data.error) return reject(new Error(ev.data.error));
          results[ev.data.job] = ev.data.result!;
          done++;
          onProgress(done, jobs.length);
          if (done === jobs.length) resolve(results);
          else feed(w);
        };
        w.onerror = (e) => reject(new Error(e.message || 'experiment worker failed'));
        feed(w);
      }
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
