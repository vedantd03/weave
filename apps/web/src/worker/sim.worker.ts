/// <reference lib="webworker" />
import { createSim, Network, type Sim } from '@weave/engine';
import { FRAME_STRIDE, ToWorker, type FromWorker, type MetricsDelta } from '@weave/engine/protocol';

/**
 * Simulation worker. Every inbound message is validated against the zod protocol.
 * While playing, it advances simulated time at `speed` × wall-clock time within a per-tick
 * compute budget, and posts at most ~60 frames/s (each a fresh transferable buffer).
 */
declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 16;
const BUDGET_MS = 12;
const METRICS_EVERY_MS = 250;

let sim: Sim | null = null;
let playing = false;
let speed = 1;
let lastTick = 0;
let carry = 0; // fractional steps owed
let lastMetrics = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let seriesSent = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function metrics(s: Sim): MetricsDelta {
  const c = s.counters();
  let sum = 0;
  const vs = s.vehicles();
  for (const v of vs) sum += v.v;
  return {
    t: s.t,
    vehiclesOnNetwork: c.onNetwork,
    entryQueue: c.entryQueue,
    generated: c.generated,
    exited: c.exited,
    meanSpeedMps: vs.length ? sum / vs.length : 0,
    ...s.diagnostics(),
    gridlock: s.gridlock(),
  };
}

function sendFrame(withMetrics: boolean): void {
  if (!sim) return;
  // Series rows first, so a waiter resolved by this frame already sees them.
  const rows = sim.series();
  if (rows.length > seriesSent) {
    post({ type: 'series', fromIndex: seriesSent, rows: rows.slice(seriesSent) });
    seriesSent = rows.length;
  }
  const n = sim.vehicleCount();
  const data = new Float32Array(Math.max(n, 1) * FRAME_STRIDE);
  const count = sim.writeFrame(data);
  const signals = new Uint8Array(sim.signalCodes());
  post(
    {
      type: 'frame',
      t: sim.t,
      step: sim.step,
      count,
      data,
      signals,
      stateHash: sim.stateHash(),
      metrics: withMetrics ? metrics(sim) : undefined,
    },
    [data.buffer, signals.buffer],
  );
}

function tick(): void {
  timer = null;
  if (!sim || !playing) return;
  const now = performance.now();
  const dt = sim.dt;
  carry += ((now - lastTick) / 1000) * speed / dt;
  lastTick = now;
  const start = performance.now();
  while (carry >= 1 && performance.now() - start < BUDGET_MS) {
    sim.advance(1);
    carry -= 1;
  }
  // Drop owed steps we could not afford (sim runs slower than requested, never spirals).
  if (carry > 1) carry = 1;
  const withMetrics = now - lastMetrics > METRICS_EVERY_MS;
  if (withMetrics) lastMetrics = now;
  sendFrame(withMetrics);
  timer = setTimeout(tick, TICK_MS);
}

function stop(): void {
  playing = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

self.onmessage = (ev: MessageEvent<unknown>) => {
  const parsed = ToWorker.safeParse(ev.data);
  if (!parsed.success) {
    post({ type: 'error', message: `invalid message: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
    return;
  }
  const msg = parsed.data;
  try {
    switch (msg.type) {
      case 'ping':
        post({ type: 'pong', nonce: msg.nonce });
        break;
      case 'init': {
        stop();
        const network = msg.network ? Network.parse(msg.network) : undefined;
        sim = createSim({ scenario: msg.scenario, classes: msg.classes, network });
        seriesSent = 0;
        post({ type: 'ready', network: sim.network, stateHash: sim.stateHash() });
        sendFrame(true);
        break;
      }
      case 'play':
        if (!sim || playing) break;
        playing = true;
        lastTick = performance.now();
        carry = 0;
        tick();
        break;
      case 'pause':
        stop();
        if (sim) sendFrame(true);
        break;
      case 'step':
        if (!sim) break;
        stop();
        sim.advance(msg.steps);
        sendFrame(true);
        break;
      case 'setSpeed':
        speed = msg.factor;
        break;
      case 'reset':
        stop();
        sim = null;
        break;
    }
  } catch (e) {
    stop();
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
