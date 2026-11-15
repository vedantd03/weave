import {
  applySweep,
  compareRuns,
  defaultClasses,
  ExperimentFile,
  METRICS,
  pairable,
  retimedFlyoverScenario,
  runCount,
  summarize,
  sweepParams,
  type CI,
  type ExperimentDesignInput as ExperimentDesign,
  type ExperimentFileInput,
  type MetricId,
  type Network,
  type ReplicateResult,
  type ScenarioInput,
} from '@weave/engine';
import { Cancelled, ExperimentPool, type Progress } from '../worker/pool.ts';

/** Experiments for traffic studies (docs/MODEL.md §7.4): designs, runs, results, history. */

export type ExpType = ExperimentDesign['type'];
export type { ExperimentDesign };
export { Cancelled };
export type { Progress };

/** Metrics shown by default; the stability flags are always shown on their own rows. */
export const DEFAULT_METRICS: MetricId[] = ['meanDelayS', 'throughputVph', 'meanSpeedKmh', 'maxEntryQueue'];
export const FLAGS: { metric: MetricId; label: string; testId: string; title: string }[] = [
  { metric: 'gridlocked', label: 'Gridlocked runs', testId: 'gridlocked-runs', title: 'Runs with at least one locked junction at the end' },
  { metric: 'queueGrowing', label: 'Queue still growing', testId: 'queue-growing-runs', title: 'Entry queue grew by more than one minute of demand (and 10 vehicles) over the second half of the window' },
  { metric: 'networkGrowing', label: 'Network still filling', testId: 'network-growing-runs', title: 'Vehicles inside the network grew by more than one minute of demand (and 10) over the second half of the window' },
];
export const FLAG_IDS = new Set<string>(FLAGS.map((f) => f.metric));

/* ---------------- flyover one-click variants ---------------- */

type JunctionLike = { generator: 'junction'; flyover?: Record<string, unknown> & { enabled: boolean } } & Record<string, unknown>;
export function junctionParams(s: ScenarioInput): JunctionLike | null {
  return s.network.kind === 'generator' && s.network.params.generator === 'junction' ? (s.network.params as unknown as JunctionLike) : null;
}
const DEFAULT_FLYOVER = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 150, heightM: 6.5 };
export function withFlyover(s: ScenarioInput, enabled: boolean): ScenarioInput {
  const p = junctionParams(s)!;
  const fly = { ...DEFAULT_FLYOVER, ...(p.flyover ?? {}), enabled };
  return { ...s, network: { kind: 'generator', params: { ...p, flyover: fly } as never }, signalOverrides: [] };
}
export type FlyoverVariant = 'flyover-off' | 'flyover-same' | 'flyover-retimed';
export const FLYOVER_VARIANTS: { id: FlyoverVariant; label: string }[] = [
  { id: 'flyover-off', label: 'Flyover off' },
  { id: 'flyover-same', label: 'Flyover on (same timings)' },
  { id: 'flyover-retimed', label: 'Flyover on (retimed)' },
];
export function flyoverVariant(s: ScenarioInput, v: FlyoverVariant): ScenarioInput {
  if (v === 'flyover-off') return withFlyover(s, false);
  if (v === 'flyover-same') return withFlyover(s, true);
  return retimedFlyoverScenario({ scenario: withFlyover(s, true), classes: defaultClasses() });
}

/* ---------------- designs and jobs ---------------- */

export interface Group {
  label: string;
  scenario: ScenarioInput;
  /** Sweep: the parameter value of this point. */
  value?: number | string;
}

export function groupsOf(d: ExperimentDesign, network?: Network): Group[] {
  const timing = (s: ScenarioInput): ScenarioInput => ({ ...s, durationS: d.durationS, warmupS: d.warmupS });
  if (d.type === 'replicate') return [{ label: d.scenario.name, scenario: timing(d.scenario) }];
  if (d.type === 'compare') return d.scenarios.map((x) => ({ label: x.name, scenario: timing(x.scenario) }));
  const p = sweepParams(d.scenario, network).find((q) => q.id === d.param);
  return d.values.map((v) => ({
    label: `${p?.label ?? d.param} = ${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}${p?.unit && typeof v === 'number' ? ` ${p.unit}` : ''}`,
    scenario: timing(applySweep(d.scenario, network, d.param, v)),
    value: v,
  }));
}

/** Seeds scenario.seed + i, the same in every group (§7.3). */
export function seedsOf(d: ExperimentDesign): number[] {
  const base = d.type === 'compare' ? d.scenarios[0]!.scenario.seed : d.scenario.seed;
  return Array.from({ length: d.reps }, (_, i) => base + i);
}

export function runsOf(d: ExperimentDesign): number {
  return runCount({ type: d.type, reps: d.reps, ...(d.type === 'compare' ? { scenarios: d.scenarios } : {}), ...(d.type === 'sweep' ? { values: d.values } : {}) });
}

/* ---------------- results ---------------- */

export interface GroupResult extends Group {
  runs: ReplicateResult[];
  summary: Record<MetricId, CI>;
  /** Against the baseline (Compare) or the first point (Sweep); absent for the reference. */
  diff?: Record<MetricId, CI>;
  paired?: boolean;
  pairingNote?: string;
}

export interface ExperimentResult {
  id: string;
  name: string;
  createdAt: string;
  design: ExperimentDesign;
  groups: GroupResult[];
}

export function buildResult(d: ExperimentDesign, network: Network | undefined, runs: ReplicateResult[], meta: { id?: string; name?: string; createdAt?: string } = {}): ExperimentResult {
  const groups = groupsOf(d, network);
  const per = d.reps;
  const out: GroupResult[] = groups.map((g, i) => {
    const rs = runs.slice(i * per, (i + 1) * per);
    return { ...g, runs: rs, summary: summarize(rs) };
  });
  if (d.type !== 'replicate') {
    const ref = out[0]!;
    for (const g of out.slice(1)) {
      const pr = pairable(ref.scenario, g.scenario);
      g.paired = pr.paired;
      g.pairingNote = pr.paired ? 'paired by seed' : `Welch (unpaired): ${pr.reason}, so arrivals do not line up`;
      g.diff = compareRuns(ref.runs, g.runs, pr.paired);
    }
  }
  return {
    id: meta.id ?? `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: meta.name ?? d.name,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    design: d,
    groups: out,
  };
}

let pool: ExperimentPool | null = null;

/** Run a design in the worker pool. Cancel with cancelExperiment(). */
export async function runDesign(d: ExperimentDesign, network: Network | undefined, onProgress: (p: Progress) => void, meta?: { name?: string }): Promise<ExperimentResult> {
  pool ??= new ExperimentPool();
  const classes = defaultClasses();
  const seeds = seedsOf(d);
  const groups = groupsOf(d, network);
  const net = (s: ScenarioInput) => (s.network.kind === 'file' ? network : undefined);
  const jobs = groups.flatMap((g) => seeds.map((seed) => ({ scenario: g.scenario, classes, network: net(g.scenario), seed })));
  const runs = await pool.run(jobs, onProgress);
  return buildResult(d, network, runs, meta);
}

export function cancelExperiment(): void {
  pool?.abort();
  pool = null;
}

/** Estimated wall time per run (ms): a probe of min(120 s, duration), scaled to the duration. */
export async function estimateRunMs(d: ExperimentDesign, network: Network | undefined): Promise<{ perRunMs: number; workers: number }> {
  const g = groupsOf(d, network)[0]!;
  const probeS = Math.min(120, d.durationS);
  const workers = pool?.size ?? Math.max(1, (Number(new URLSearchParams(window.location.search).get('workers')) || (navigator.hardwareConcurrency || 2) - 1));
  const ms = await ExperimentPool.probe({ scenario: g.scenario, classes: defaultClasses(), network: g.scenario.network.kind === 'file' ? network : undefined, seed: g.scenario.seed }, probeS);
  // Early simulated time has fewer vehicles than the rest of the run: scale up modestly.
  return { perRunMs: ms * (d.durationS / probeS) * (d.durationS > probeS ? 1.3 : 1), workers };
}

/* ---------------- export, import, CSV ---------------- */

const num = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '' : String(Math.round(x * 1e6) / 1e6));

/** One row per run: group, seed and every metric including the three stability flags. */
export function toCsv(r: ExperimentResult): string {
  const head = ['group', 'label', 'seed', ...METRICS];
  const lines = [head.join(',')];
  r.groups.forEach((g, i) => {
    for (const run of g.runs) lines.push([String(i), `"${g.label.replace(/"/g, '""')}"`, String(run.seed), ...METRICS.map((m) => num(run.metrics[m]))].join(','));
  });
  return lines.join('\n') + '\n';
}

export function toFile(r: ExperimentResult): ExperimentFileInput {
  return {
    kind: 'weave-experiment',
    version: 1,
    name: r.name,
    createdAt: r.createdAt,
    design: r.design,
    results: {
      runs: r.groups.flatMap((g, i) =>
        g.runs.map((run) => ({
          group: i,
          seed: run.seed,
          metrics: Object.fromEntries(Object.entries(run.metrics).map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
          breakdown: run.breakdown,
        })),
      ),
    },
  };
}

export function fromFile(f: ExperimentFileInput, network: Network | undefined): ExperimentResult | null {
  if (!f.results) return null;
  const runs = [...f.results.runs]
    .sort((a, b) => a.group - b.group)
    .map((x) => ({ seed: x.seed, metrics: Object.fromEntries(Object.entries(x.metrics).map(([k, v]) => [k, v ?? NaN])) as Record<MetricId, number>, breakdown: x.breakdown as ReplicateResult['breakdown'] }));
  return buildResult(f.design, network, runs, { name: f.name, createdAt: f.createdAt });
}

/* ---------------- history (memory + browser storage) ---------------- */

const KEY = 'weave.experiments.v1';
const MAX_SAVED = 20;
let memory: ExperimentFileInput[] | null = null;

export function loadHistory(): ExperimentFileInput[] {
  if (memory) return memory;
  memory = [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown[];
      memory = arr.filter((x) => ExperimentFile.safeParse(x).success) as ExperimentFileInput[];
    }
  } catch {
    // storage unavailable or corrupt: history lives in memory only
  }
  return memory;
}

function persist(): void {
  try {
    // Breakdowns are bulky: stored entries keep only the run metrics.
    const slim = (memory ?? []).map((f) => ({ ...f, results: f.results ? { runs: f.results.runs.map(({ breakdown: _b, ...r }) => r) } : undefined }));
    window.localStorage.setItem(KEY, JSON.stringify(slim));
  } catch {
    // quota or privacy mode: keep the in-memory copy
  }
}

export function saveToHistory(f: ExperimentFileInput): ExperimentFileInput[] {
  const list = loadHistory().filter((x) => !(x.createdAt === f.createdAt && x.name === f.name));
  memory = [f, ...list].slice(0, MAX_SAVED);
  persist();
  return memory;
}

export function renameInHistory(createdAt: string, name: string): ExperimentFileInput[] {
  memory = loadHistory().map((x) => (x.createdAt === createdAt ? { ...x, name } : x));
  persist();
  return memory;
}

export function deleteFromHistory(createdAt: string): ExperimentFileInput[] {
  memory = loadHistory().filter((x) => x.createdAt !== createdAt);
  persist();
  return memory;
}

/* ---------------- legacy test hook (m4 e2e) ---------------- */

export type CompareId = 'none' | 'flyover-off' | 'flyover-same' | 'flyover-retimed' | 'plan-edited';

/** The M4 hook: base = scenario (or flyover off), variant per CompareId; seeds scenario.seed + i. */
export async function runExperiment(s: ScenarioInput, network: Network | undefined, replications: number, c: CompareId, onProgress: (done: number, total: number) => void) {
  const pairs: Record<CompareId, [ScenarioInput, ScenarioInput | null]> = {
    none: [s, null],
    'flyover-off': [s, junctionParams(s) ? withFlyover(s, false) : null],
    'flyover-same': [junctionParams(s) ? withFlyover(s, false) : s, junctionParams(s) ? withFlyover(s, true) : null],
    'flyover-retimed': [junctionParams(s) ? withFlyover(s, false) : s, junctionParams(s) ? flyoverVariant(s, 'flyover-retimed') : null],
    'plan-edited': [{ ...s, signalOverrides: [] }, s],
  };
  const [base, variant] = pairs[c];
  const common = { name: 'hook', reps: replications, durationS: s.durationS, warmupS: s.warmupS ?? 300, metrics: [] };
  const d: ExperimentDesign = variant
    ? { type: 'compare', scenarios: [{ name: 'base', scenario: base }, { name: 'variant', scenario: variant }], ...common }
    : { type: 'replicate', scenario: base, ...common };
  const r = await runDesign(d, network, (p) => onProgress(p.done, p.total));
  return { base: r.groups[0]!.runs, variant: r.groups[1]?.runs };
}
