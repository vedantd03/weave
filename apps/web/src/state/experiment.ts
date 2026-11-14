import {
  compare as compareResults,
  defaultClasses,
  METRICS,
  METRIC_LABELS,
  retimedFlyoverScenario,
  summarize,
  type CI,
  type MetricId,
  type Network,
  type ReplicateResult,
  type ScenarioInput,
} from '@weave/engine';
import { ExperimentPool } from '../worker/pool.ts';

/** Comparison options (MODEL.md §5.3–5.4). */
export type CompareId = 'none' | 'flyover-off' | 'flyover-same' | 'flyover-retimed' | 'plan-edited';

export interface ExperimentOutcome {
  base: ReplicateResult[];
  variant?: ReplicateResult[];
  baseLabel: string;
  variantLabel?: string;
  summaryBase: Record<MetricId, CI>;
  summaryVariant?: Record<MetricId, CI>;
  diff?: Record<MetricId, CI>;
}

type JunctionLike = { generator: 'junction'; flyover?: Record<string, unknown> & { enabled: boolean } } & Record<string, unknown>;

function junctionParams(s: ScenarioInput): JunctionLike | null {
  return s.network.kind === 'generator' && s.network.params.generator === 'junction' ? (s.network.params as unknown as JunctionLike) : null;
}

const DEFAULT_FLYOVER = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 150, heightM: 6.5 };

function withFlyover(s: ScenarioInput, enabled: boolean): ScenarioInput {
  const p = junctionParams(s)!;
  const fly = { ...DEFAULT_FLYOVER, ...(p.flyover ?? {}), enabled };
  return { ...s, network: { kind: 'generator', params: { ...p, flyover: fly } as never }, signalOverrides: [] };
}

export function compareOptions(s: ScenarioInput): { value: CompareId; label: string }[] {
  const out: { value: CompareId; label: string }[] = [{ value: 'none', label: 'None' }];
  if (junctionParams(s)) {
    out.push(
      { value: 'flyover-off', label: 'Flyover off' },
      { value: 'flyover-same', label: 'Flyover on (same timings)' },
      { value: 'flyover-retimed', label: 'Flyover on (retimed)' },
    );
  }
  if ((s.signalOverrides ?? []).length > 0) out.push({ value: 'plan-edited', label: 'Signal plan as edited' });
  return out;
}

/** Base and variant scenarios for a comparison. */
export function variants(s: ScenarioInput, c: CompareId): { base: ScenarioInput; variant?: ScenarioInput; baseLabel: string; variantLabel?: string } {
  const classes = defaultClasses();
  switch (c) {
    case 'flyover-off':
      return { base: s, variant: withFlyover(s, false), baseLabel: 'As configured', variantLabel: 'Flyover off' };
    case 'flyover-same':
      return { base: withFlyover(s, false), variant: withFlyover(s, true), baseLabel: 'Flyover off', variantLabel: 'Flyover on' };
    case 'flyover-retimed': {
      const on = withFlyover(s, true);
      return {
        base: withFlyover(s, false),
        variant: retimedFlyoverScenario({ scenario: on, classes }),
        baseLabel: 'Flyover off',
        variantLabel: 'Flyover on, retimed',
      };
    }
    case 'plan-edited':
      return { base: { ...s, signalOverrides: [] }, variant: s, baseLabel: 'Original plan', variantLabel: 'Edited plan' };
    default:
      return { base: s, baseLabel: 'Scenario' };
  }
}

let pool: ExperimentPool | null = null;

export async function runExperiment(
  s: ScenarioInput,
  network: Network | undefined,
  replications: number,
  c: CompareId,
  onProgress: (done: number, total: number) => void,
): Promise<ExperimentOutcome> {
  pool ??= new ExperimentPool();
  const classes = defaultClasses();
  const v = variants(s, c);
  const seeds = Array.from({ length: replications }, (_, i) => s.seed + i);
  const jobs = [
    ...seeds.map((seed) => ({ scenario: v.base, classes, network, seed })),
    ...(v.variant ? seeds.map((seed) => ({ scenario: v.variant!, classes, network, seed })) : []),
  ];
  const all = await pool.run(jobs, onProgress);
  const base = all.slice(0, replications);
  const variant = v.variant ? all.slice(replications) : undefined;
  return {
    base,
    variant,
    baseLabel: v.baseLabel,
    variantLabel: v.variantLabel,
    summaryBase: summarize(base),
    summaryVariant: variant ? summarize(variant) : undefined,
    diff: variant ? compareResults(base, variant) : undefined,
  };
}

const f = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : '');

export function toCsv(o: ExperimentOutcome): string {
  const head = ['metric', 'unit', `${o.baseLabel} mean`, `${o.baseLabel} ci95_half`];
  if (o.variant) head.push(`${o.variantLabel} mean`, `${o.variantLabel} ci95_half`, 'difference mean', 'difference ci95_lo', 'difference ci95_hi');
  const lines = [head.join(',')];
  for (const m of METRICS) {
    const row = [m, METRIC_LABELS[m].unit, f(o.summaryBase[m].mean), f(o.summaryBase[m].half)];
    if (o.summaryVariant && o.diff) row.push(f(o.summaryVariant[m].mean), f(o.summaryVariant[m].half), f(o.diff[m].mean), f(o.diff[m].lo), f(o.diff[m].hi));
    lines.push(row.map((x) => (x.includes(',') ? `"${x}"` : x)).join(','));
  }
  lines.push('', ['variant', 'seed', ...METRICS].join(','));
  for (const [label, rs] of [[o.baseLabel, o.base], [o.variantLabel ?? '', o.variant ?? []]] as const) {
    for (const r of rs) lines.push([label, String(r.seed), ...METRICS.map((m) => f(r.metrics[m]))].join(','));
  }
  return lines.join('\n') + '\n';
}
