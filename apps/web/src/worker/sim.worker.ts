/// <reference lib="webworker" />
import { ToWorker, type FromWorker } from '@weave/engine/protocol';

/**
 * Simulation worker. Every inbound message is validated against the zod protocol before use.
 * M0: transport only (ping/pong); the engine is wired in at M1.
 */
declare const self: DedicatedWorkerGlobalScope;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<unknown>) => {
  const parsed = ToWorker.safeParse(ev.data);
  if (!parsed.success) {
    post({ type: 'error', message: `invalid message: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
    return;
  }
  const msg = parsed.data;
  switch (msg.type) {
    case 'ping':
      post({ type: 'pong', nonce: msg.nonce });
      break;
    default:
      post({ type: 'error', message: `${msg.type}: engine not wired yet` });
  }
};
