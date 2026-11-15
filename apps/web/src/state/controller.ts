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
  RunExport,
  type RunExportBody,
} from '@weave/engine';
import type { FromWorker } from '@weave/engine/protocol';
import { Renderer, type FrameView, type Selection } from '../render/renderer.ts';
import { SIGNAL_STATES } from '../render/select.ts';
import { decodeScenario, hashToken, writeScenarioToUrl } from './urlScenario.ts';
import { FRAME_STRIDE, F_CLASS, F_LENGTH, F_SEG, F_SPEED, F_WIDTH } from '@weave/engine/protocol';
import type { ColourMode } from '../render/palette.ts';
import { SimClient } from '../worker/client.ts';

/** The preset the app opens on (§6.3 item 1). */
export const DEFAULT_PRESET = 'junction4-flyover';

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
  /** Vehicle colouring on the map (§6.3 item 2). */
  colourMode: ColourMode;
  /** 2D canvas or the lazily loaded 3D view (§6.3 item 4). */
  view: '2d' | '3d';
  view3dStatus: 'off' | 'loading' | 'ready' | 'error';
  view3dError: string | null;
  /** Map inspection card (§6.3 item 5), or null. */
  inspect: InspectInfo | null;
}

export type InspectInfo =
  | { kind: 'vehicle'; classLabel: string; speedKmh: number; segment: string; lengthM: number; widthM: number }
  | { kind: 'road'; segKind: 'link' | 'movement'; id: string; widthM: number; lanes: number | null; speedLimitKmh: number; onNow: number; meanSpeedKmh: number }
  | { kind: 'signal'; movement: string; from: string; to: string; node: string; state: string };

type Listener = () => void;

/**
 * Owns the worker, the renderer and the observable UI state. Frames go straight to the
 * renderer (never through React); React sees throttled snapshots via useSyncExternalStore.
 */
export class SimController {
  private client = new SimClient();
  private renderer: Renderer | null = null;
  private scene3d: {
    setNetwork(n: Network, ids: string[]): void;
    setFrame(f: FrameView): void;
    setColourMode(m: ColourMode): void;
    setSelectionListener(cb: ((s: Selection | null) => void) | null): void;
    clearSelection(): void;
    worldToClient(x: number, y: number, z: number): { x: number; y: number };
    signalLights(): { movement: string; colour: string }[];
    signalLightClient(i: number): { x: number; y: number };
    destroy(): void;
  } | null = null;
  private scene3dToken = 0;
  /** Resolves when the 3D scene of the current mount exists (test hooks wait on it). */
  private scene3dReady: Promise<void> = Promise.resolve();
  private markScene3dReady: () => void = () => {};
  private lastFrame: FrameView | null = null;
  private listeners = new Set<Listener>();
  private frameWaiters: Array<{ step: number; resolve: () => void }> = [];
  private lastUiUpdate = 0;
  /** Inits sent and 'ready' replies seen: the worker answers in order, so while
   * readies < inits, messages belong to a superseded load and are ignored. */
  private initsSent = 0;
  /** Resolves once the start-up open (default preset, warm-up) has finished or been skipped. */
  private markOpened: () => void = () => {};
  private opened: Promise<void> = new Promise((r) => (this.markOpened = r));
  /** Resolves when the most recent load's first frame has arrived. */
  private pendingLoad: Promise<void> = Promise.resolve();
  private readies = 0;
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
      colourMode: 'class',
      view: '2d',
      view3dStatus: 'off',
      view3dError: null,
      inspect: null,
    };
    this.client.on((m) => this.onMessage(m));
    this.client
      .ping()
      .then((ms) => {
        this.set({ status: 'idle', workerPingMs: ms });
        return this.openDefault();
      })
      .catch((e: unknown) => this.set({ status: 'error', error: String(e) }))
      .finally(() => this.markOpened());
  }

  /**
   * Open on a ready scenario (MODEL.md §6.3 item 1, revision 4): the 4-arm flyover preset, or
   * `?preset=<id>`, loaded and paused at t = 0. Nothing is simulated until Play or Step.
   */
  private async openDefault(): Promise<void> {
    // Something (the user or a test hook) already asked for a scenario: don't replace it.
    if (this.initsSent > 0) return;
    // A shared link (#s=…) restores its scenario, paused at t = 0 (§7.4).
    const token = hashToken();
    if (token) {
      const shared = await decodeScenario(token);
      if (shared && this.initsSent === 0) {
        await this.loadScenario(shared, PRESETS[shared.id] ? shared.id : null);
        return;
      }
    }
    const id = new URLSearchParams(window.location.search).get('preset') ?? DEFAULT_PRESET;
    await this.load(PRESETS[id] ? id : DEFAULT_PRESET);
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

  /** Where the default view should centre: a corridor's change point, else the network centre. */
  private focusOf(net: Network): [number, number] | null {
    const s = this.state.scenario;
    if (s?.network.kind === 'generator' && s.network.params.generator === 'corridor' && s.network.params.change.kind !== 'none') {
      const c = s.network.params.change;
      const node = net.nodes.find((n) => n.id === 'n1');
      return node ? [c.atM + (c.taperM ?? 0) / 2, node.y] : null;
    }
    return null;
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.renderer?.destroy();
    this.renderer = canvas ? new Renderer(canvas) : null;
    this.renderer?.setColourMode(this.state.colourMode);
    this.renderer?.setSelectionListener((sel) => this.onSelection(sel));
    if (this.renderer && this.state.network) {
      this.renderer.setNetwork(this.state.network, this.state.classes.classes.map((c) => c.id));
    }
  }

  private lastInspectUi = 0;

  private onSelection(sel: Selection | null): void {
    const net = this.state.network;
    if (!sel || !net) {
      if (this.state.inspect) this.set({ inspect: null });
      return;
    }
    // Live values change every frame: refresh the card at most ~8 times a second (a signal's
    // state change always shows at once).
    const now = performance.now();
    const cur = this.state.inspect;
    const signalChanged = sel.kind === 'signal' && cur?.kind === 'signal' && cur.state !== (SIGNAL_STATES[sel.code] ?? 'No signal');
    if (cur && sel.kind === cur.kind && !signalChanged && now - this.lastInspectUi < 120) return;
    this.lastInspectUi = now;
    const segId = (i: number) => (i < net.links.length ? net.links[i]!.id : net.movements[i - net.links.length]?.id ?? '?');
    if (sel.kind === 'vehicle') {
      const r = sel.rec;
      const cls = this.state.classes.classes[r[F_CLASS]! | 0];
      this.set({
        inspect: { kind: 'vehicle', classLabel: cls?.label ?? '?', speedKmh: r[F_SPEED]! * 3.6, segment: segId(r[F_SEG]!), lengthM: r[F_LENGTH]!, widthM: r[F_WIDTH]! },
      });
      return;
    }
    if (sel.kind === 'signal') {
      const mv = net.movements[sel.movement]!;
      this.set({ inspect: { kind: 'signal', movement: mv.id, from: mv.fromLink, to: mv.toLink, node: mv.node, state: SIGNAL_STATES[sel.code] ?? 'No signal' } });
      return;
    }
    const isLink = sel.seg < net.links.length;
    const link = isLink ? net.links[sel.seg]! : null;
    const mv = isLink ? null : net.movements[sel.seg - net.links.length]!;
    const limit = link ? link.speedLimitMps : Math.min(...[mv!.fromLink, mv!.toLink].map((id) => net.links.find((l) => l.id === id)?.speedLimitMps ?? Infinity));
    this.set({
      inspect: {
        kind: 'road',
        segKind: isLink ? 'link' : 'movement',
        id: link ? link.id : mv!.id,
        widthM: link ? link.widthM : mv!.widthM,
        lanes: link ? link.lanes : null,
        speedLimitKmh: limit * 3.6,
        onNow: sel.onNow,
        meanSpeedKmh: sel.meanSpeedMps * 3.6,
      },
    });
  }

  clearInspect(): void {
    this.renderer?.clearSelection();
    this.scene3d?.clearSelection();
  }

  /**
   * Build the run export (MODEL.md §6.4): the worker computes the body from its sim, this adds
   * the manifest fields only the app knows, and the whole thing is validated before use.
   */
  async exportRun(): Promise<{ run: RunExport; filename: string }> {
    const scenario = this.state.scenario;
    if (!scenario || this.state.status !== 'ready' || this.state.t <= 0) throw new Error('pause a run with data first');
    const nonce = Math.random();
    const body = await new Promise<RunExportBody>((resolve, reject) => {
      const off = this.client.on((m) => {
        if (m.type === 'export' && m.nonce === nonce) {
          off();
          resolve(m.body);
        } else if (m.type === 'error') {
          off();
          reject(new Error(m.message));
        }
      });
      this.client.send({ type: 'export', nonce });
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(this.state.classes)));
    const classesHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const run = {
      manifest: {
        buildSha: __WEAVE_COMMIT__,
        engineVersion: __WEAVE_ENGINE_VERSION__,
        schemaVersion: scenario.version,
        classesHash,
        ...body.manifest,
        exportedAt: new Date().toISOString(),
      },
      scenario,
      metrics: body.metrics,
      series: body.series,
      links: body.links,
      trips: body.trips,
      diagnostics: body.diagnostics,
    };
    RunExport.parse(run); // never hand out an export that does not match its schema
    const id = this.state.presetId ?? scenario.id;
    return { run: run as unknown as RunExport, filename: `weave-run-${id}-seed${body.manifest.seed}-t${body.manifest.simulatedTimeS.toFixed(1)}` };
  }

  setView(view: '2d' | '3d'): void {
    // The card belongs to the view it was picked in.
    this.renderer?.clearSelection();
    this.scene3d?.clearSelection();
    this.set({ view, ...(view === '3d' ? { view3dError: null } : {}) });
  }

  /** Mount or unmount the 3D view; three.js is imported only on the first mount. */
  attach3D(canvas: HTMLCanvasElement | null): void {
    this.scene3d?.destroy();
    this.scene3d = null;
    if (!canvas) {
      this.set({ view3dStatus: 'off' });
      return;
    }
    this.set({ view3dStatus: 'loading' });
    this.scene3dReady = new Promise((r) => (this.markScene3dReady = r));
    const token = ++this.scene3dToken;
    import('../render/Scene3D.ts')
      .then(({ Scene3D }) => {
        if (token !== this.scene3dToken) return;
        const scene = new Scene3D(canvas);
        this.scene3d = scene;
        scene.setSelectionListener((sel) => this.onSelection(sel));
        scene.setColourMode(this.state.colourMode);
        if (this.state.network) scene.setNetwork(this.state.network, this.state.classes.classes.map((c) => c.id));
        if (this.lastFrame) scene.setFrame(this.lastFrame);
        this.set({ view3dStatus: 'ready' });
        this.markScene3dReady();
      })
      .catch((e: unknown) => {
        if (token !== this.scene3dToken) return;
        const msg = e instanceof Error ? e.message : String(e);
        this.set({ view: '2d', view3dStatus: 'error', view3dError: `3D view unavailable (${msg}). Showing 2D.` });
        this.markScene3dReady();
      });
  }

  setColourMode(mode: ColourMode): void {
    this.scene3d?.setColourMode(mode);
    this.renderer?.setColourMode(mode);
    this.set({ colourMode: mode });
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
    this.pendingLoad = ready;
    void writeScenarioToUrl(scenario);
    this.initsSent++;
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
  async step(steps = 1): Promise<void> {
    // A step requested during start-up or while a scenario is (re)building applies to that scenario.
    if (this.state.status === 'starting' || this.state.status === 'idle') await this.opened;
    if (this.state.status === 'loading') await this.pendingLoad;
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
    if (m.type === 'ready') this.readies++;
    const stale = this.readies < this.initsSent;
    if (stale && (m.type === 'ready' || m.type === 'frame' || m.type === 'series')) return;
    switch (m.type) {
      case 'ready':
        this.renderer?.setNetwork(m.network, this.state.classes.classes.map((c) => c.id), this.focusOf(m.network));
        this.scene3d?.setNetwork(m.network, this.state.classes.classes.map((c) => c.id));
        this.lastFrame = null;
        this.set({ network: m.network, stateHash: m.stateHash, status: 'ready' });
        break;
      case 'frame': {
        this.lastSignals = m.signals;
        const frame = { data: m.data, count: m.count, signals: m.signals };
        this.lastFrame = frame;
        this.renderer?.setFrame(frame);
        this.scene3d?.setFrame(frame);
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
      frame: async () => {
        const f = this.lastFrame;
        return f ? { data: Array.from(f.data.subarray(0, f.count * FRAME_STRIDE)), count: f.count } : { data: [], count: 0 };
      },
      worldToScreen: async (x: number, y: number) => this.renderer?.worldToClient(x, y) ?? { x: NaN, y: NaN },
      worldToScreen3d: async (x: number, y: number, z: number) => {
        if (this.state.view === '3d') await this.scene3dReady;
        return this.scene3d?.worldToClient(x, y, z) ?? { x: NaN, y: NaN };
      },
      signalLights3d: async () => {
        if (this.state.view === '3d') await this.scene3dReady;
        return this.scene3d?.signalLights() ?? [];
      },
      signalLightPos3d: async (i: number) => {
        if (this.state.view === '3d') await this.scene3dReady;
        return this.scene3d?.signalLightClient(i) ?? { x: NaN, y: NaN };
      },
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
