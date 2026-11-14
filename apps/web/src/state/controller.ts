import {
  defaultClasses,
  generateNetwork,
  Network,
  GeneratorParams,
  PRESETS,
  type ClassSet,
  type MetricsDelta,
  type ScenarioInput,
  type SeriesRow,
} from '@weave/engine';
import type { FromWorker } from '@weave/engine/protocol';
import { Renderer } from '../render/renderer.ts';
import { SimClient } from '../worker/client.ts';

export type Status = 'starting' | 'idle' | 'loading' | 'ready' | 'playing' | 'error';

export interface SimState {
  status: Status;
  error: string | null;
  presetId: string | null;
  seed: number;
  speed: number;
  t: number;
  step: number;
  stateHash: string;
  vehicles: number;
  metrics: MetricsDelta | null;
  network: Network | null;
  classes: ClassSet;
  workerPingMs: number | null;
  /** The scenario currently loaded in the worker (null before the first load). */
  scenario: ScenarioInput | null;
  series: SeriesRow[];
}

type Listener = () => void;

/**
 * Owns the worker, the renderer and the observable UI state. Frames go straight to the
 * renderer (never through React); React sees throttled snapshots via useSyncExternalStore.
 */
export class SimController {
  private client = new SimClient();
  private renderer: Renderer | null = null;
  private listeners = new Set<Listener>();
  private frameWaiters: Array<{ step: number; resolve: () => void }> = [];
  private lastUiUpdate = 0;
  state: SimState;

  constructor() {
    this.state = {
      status: 'starting',
      error: null,
      presetId: null,
      seed: 42,
      speed: 1,
      t: 0,
      step: 0,
      stateHash: '',
      vehicles: 0,
      metrics: null,
      network: null,
      classes: defaultClasses(),
      workerPingMs: null,
      scenario: null,
      series: [],
    };
    this.client.on((m) => this.onMessage(m));
    this.client
      .ping()
      .then((ms) => this.set({ status: 'idle', workerPingMs: ms }))
      .catch((e: unknown) => this.set({ status: 'error', error: String(e) }));
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): SimState => this.state;

  private set(patch: Partial<SimState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.renderer?.destroy();
    this.renderer = canvas ? new Renderer(canvas) : null;
    if (this.renderer && this.state.network) {
      this.renderer.setNetwork(this.state.network, this.state.classes.classes.map((c) => c.id));
    }
  }

  fitView(): void {
    this.renderer?.fit(true);
  }

  /** Load a preset; resolves once the worker has built the scenario and sent the first frame. */
  load(presetId: string, seed = this.state.seed): Promise<void> {
    const preset: ScenarioInput | undefined = PRESETS[presetId];
    if (!preset) return Promise.reject(new Error(`unknown preset ${presetId}`));
    return this.loadScenario({ ...preset, seed }, presetId);
  }

  private fileNetworks = new Map<string, Promise<Network>>();
  /** Last frame's signal colours per movement (SIG codes). */
  lastSignals: Uint8Array = new Uint8Array(0);

  /** Fetch (once) and validate a bundled network file such as /data/silkboard.json. */
  private fileNetwork(id: string): Promise<Network> {
    let p = this.fileNetworks.get(id);
    if (!p) {
      p = fetch(`/data/${id}.json`)
        .then((r) => {
          if (!r.ok) throw new Error(`could not load network ${id} (${r.status})`);
          return r.json();
        })
        .then((j: unknown) => Network.parse(j));
      this.fileNetworks.set(id, p);
    }
    return p;
  }

  /** Load any scenario (sim is paused afterwards). */
  async loadScenario(scenario: ScenarioInput, presetId: string | null = this.state.presetId): Promise<void> {
    const network = scenario.network.kind === 'file' ? await this.fileNetwork(scenario.network.id) : undefined;
    this.frameWaiters = [];
    this.set({
      status: 'loading',
      presetId,
      seed: scenario.seed,
      scenario,
      series: [],
      metrics: null,
      error: null,
      t: 0,
      step: 0,
    });
    const ready = this.waitForStep(0);
    this.client.send({ type: 'init', scenario, classes: this.state.classes, ...(network ? { network } : {}) });
    this.client.send({ type: 'setSpeed', factor: this.state.speed });
    return ready;
  }

  /**
   * Draw a generator's network immediately (no vehicles) while the user edits parameters.
   * Returns an error message for invalid parameters instead of throwing.
   */
  preview(params: unknown): string | null {
    const parsed = GeneratorParams.safeParse(params);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid parameters';
    try {
      const net = generateNetwork(parsed.data);
      this.renderer?.setNetwork(net, this.state.classes.classes.map((c) => c.id));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  play(): void {
    if (this.state.status !== 'ready') return;
    this.client.send({ type: 'play' });
    this.set({ status: 'playing' });
  }

  pause(): void {
    if (this.state.status !== 'playing') return;
    this.client.send({ type: 'pause' });
    this.set({ status: 'ready' });
  }

  /** Advance exactly `steps` steps (pauses first); resolves when that frame arrives. */
  step(steps = 1): Promise<void> {
    if (this.state.status === 'playing') this.pause();
    if (this.state.status !== 'ready') return Promise.reject(new Error('no scenario loaded'));
    const target = this.state.step + steps;
    const p = this.waitForStep(target);
    this.client.send({ type: 'step', steps });
    return p;
  }

  setSpeed(factor: number): void {
    this.client.send({ type: 'setSpeed', factor });
    this.set({ speed: factor });
  }

  private waitForStep(step: number): Promise<void> {
    return new Promise((resolve) => this.frameWaiters.push({ step, resolve }));
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'ready':
        this.renderer?.setNetwork(m.network, this.state.classes.classes.map((c) => c.id));
        this.set({ network: m.network, stateHash: m.stateHash, status: 'ready' });
        break;
      case 'frame': {
        this.lastSignals = m.signals;
        this.renderer?.setFrame({ data: m.data, count: m.count, signals: m.signals });
        const now = performance.now();
        const waiters = this.frameWaiters.filter((w) => w.step <= m.step);
        const force = waiters.length > 0 || m.metrics !== undefined || this.state.status !== 'playing';
        if (force || now - this.lastUiUpdate > 100) {
          this.lastUiUpdate = now;
          this.set({
            t: m.t,
            step: m.step,
            stateHash: m.stateHash,
            vehicles: m.count,
            metrics: m.metrics ?? this.state.metrics,
          });
        }
        if (waiters.length) {
          this.frameWaiters = this.frameWaiters.filter((w) => w.step > m.step);
          for (const w of waiters) w.resolve();
        }
        break;
      }
      case 'series': {
        const series = this.state.series.slice(0, m.fromIndex).concat(m.rows);
        this.set({ series });
        break;
      }
      case 'error':
        this.set({ status: 'error', error: m.message });
        break;
      case 'pong':
        break;
    }
  }

  /** Test hook (installed only with ?test=1): deterministic load/advance for e2e checks. */
  installTestHook(): void {
    const w = window as unknown as { weaveTest?: unknown };
    w.weaveTest = {
      load: (presetId: string, seed: number) => this.load(presetId, seed),
      advance: async (steps: number) => {
        await this.step(steps);
        return { hash: this.state.stateHash, t: this.state.t, count: this.state.vehicles };
      },
      loadScenario: (scenario: ScenarioInput) => this.loadScenario(scenario),
      counters: async () => {
        const m = this.state.metrics;
        return m
          ? { generated: m.generated, exited: m.exited, onNetwork: m.vehiclesOnNetwork, entryQueue: m.entryQueue }
          : { generated: 0, exited: 0, onNetwork: 0, entryQueue: 0 };
      },
      series: async () => this.state.series,
      signals: async () => Array.from(this.lastSignals),
      runExperiment: async (o: { replications: number; compare: string }) => {
        const { runExperiment } = await import('./experiment.ts');
        const s = this.state.scenario;
        if (!s) throw new Error('no scenario loaded');
        const net = s.network.kind === 'file' ? await this.fileNetwork(s.network.id) : undefined;
        const r = await runExperiment(s, net, o.replications, o.compare as never, () => {});
        return { base: r.base, variant: r.variant };
      },
      gridlock: async () => this.state.metrics?.gridlock ?? null,
      diagnostics: async () => {
        const m = this.state.metrics;
        return m ? { guardActivations: m.guardActivations, vehicleSteps: m.vehicleSteps, holds: m.holds } : null;
      },
    };
  }
}
