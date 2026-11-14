import { FromWorker, type ToWorkerInput } from '@weave/engine/protocol';

export type WorkerListener = (msg: FromWorker) => void;

/** Thin typed wrapper around the simulation worker. Validates every inbound envelope. */
export class SimClient {
  private worker: Worker;
  private listeners = new Set<WorkerListener>();

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module', name: 'weave-sim' });
    this.worker.onmessage = (ev: MessageEvent<unknown>) => {
      const parsed = FromWorker.safeParse(ev.data);
      const msg: FromWorker = parsed.success
        ? parsed.data
        : { type: 'error', message: `invalid worker message: ${parsed.error.issues[0]?.message ?? ''}` };
      for (const l of this.listeners) l(msg);
    };
    this.worker.onerror = (ev) => {
      for (const l of this.listeners) l({ type: 'error', message: ev.message || 'worker error' });
    };
  }

  send(msg: ToWorkerInput, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  on(listener: WorkerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Round-trip latency check; resolves with milliseconds. */
  ping(timeoutMs = 5000): Promise<number> {
    const nonce = Math.random();
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('worker ping timed out'));
      }, timeoutMs);
      const off = this.on((msg) => {
        if (msg.type === 'pong' && msg.nonce === nonce) {
          clearTimeout(timer);
          off();
          resolve(performance.now() - start);
        }
      });
      this.send({ type: 'ping', nonce });
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.listeners.clear();
  }
}
