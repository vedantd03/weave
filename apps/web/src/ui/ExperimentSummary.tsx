import { METRIC_LABELS, type CI, type MetricId } from '@weave/engine';
import type { ExperimentOutcome } from '../state/experiment.ts';

/** Plain-English summary and paired-difference chart for an experiment (MODEL.md §6.3 item 3). */

const num = (x: number, d = 1) =>
  (x < 0 ? '−' : '') + (Math.abs(x) >= 1000 ? Math.round(Math.abs(x)).toLocaleString('en-US') : Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : d));
const range = (ci: CI, unit: string) =>
  Number.isFinite(ci.half) ? `95% CI ${num(ci.lo)} to ${num(ci.hi)}${unit ? ` ${unit}` : ''}` : 'no interval with one seed';
const excludesZero = (ci: CI) => Number.isFinite(ci.lo) && (ci.lo > 0 || ci.hi < 0);

function flagsSentence(o: ExperimentOutcome): string {
  const all = [...o.base, ...(o.variant ?? [])];
  const g = all.filter((r) => r.metrics.gridlocked > 0).length;
  const q = all.filter((r) => r.metrics.queueGrowing > 0).length;
  const parts: string[] = [];
  parts.push(g === 0 ? 'No run ended in gridlock' : `${g} of ${all.length} runs ended in gridlock`);
  parts.push(q === 0 ? 'no entry queue was still growing at the end' : `in ${q} the entry queue was still growing at the end`);
  return `${parts.join(', and ')}.`;
}

/** Describe a paired difference of a metric where lower is better (delay) or higher is better. */
function diffSentence(o: ExperimentOutcome, m: MetricId, lowerIsBetter: boolean): string {
  const d = o.diff![m];
  const { label, unit } = METRIC_LABELS[m];
  const name = label.split(',')[0]!.toLowerCase();
  if (!Number.isFinite(d.mean)) return `${name}: not available.`;
  if (!excludesZero(d)) {
    return `There is no clear difference in ${name} (${d.mean >= 0 ? '+' : ''}${num(d.mean)} ${unit}, ${range(d, unit)}).`;
  }
  // The interval of the change's size, so the numbers read the same way as the sentence.
  const up = d.mean > 0;
  const size: CI = up ? d : { ...d, mean: -d.mean, lo: -d.hi, hi: -d.lo };
  void lowerIsBetter;
  return `With ${o.variantLabel}, ${name} ${up ? 'rose' : 'fell'} by ${num(size.mean)} ${unit} (${range(size, unit)}).`;
}

export function summaryText(o: ExperimentOutcome): string {
  const n = o.base.length;
  const seeds = `${n} seed${n === 1 ? '' : 's'}`;
  const b = o.summaryBase.meanDelayS;
  const tp = o.summaryBase.throughputVph;
  if (!o.variant || !o.diff) {
    return `Over ${seeds}, the mean delay was ${num(b.mean)} s (${range(b, 's')}) and throughput ${num(tp.mean)} veh/h. ${flagsSentence(o)}`;
  }
  const head = `Over ${seeds}, paired by seed: with ${o.baseLabel} the mean delay was ${num(b.mean)} s (${range(b, 's')}).`;
  return `${head} ${diffSentence(o, 'meanDelayS', true)} ${diffSentence(o, 'throughputVph', false)} ${flagsSentence(o)}`;
}

const CHART_METRICS: MetricId[] = ['meanDelayS', 'meanTravelTimeS', 'throughputVph', 'meanSpeedKmh'];
const SHORT: Partial<Record<MetricId, string>> = {
  meanDelayS: 'Mean delay',
  meanTravelTimeS: 'Travel time',
  throughputVph: 'Throughput',
  meanSpeedKmh: 'Mean speed',
};

function niceMax(x: number): number {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) if (x <= s) return s;
  return Math.ceil(x / 100) * 100;
}

/** Forest plot of paired differences as % of the base mean, with 95% intervals. */
export function DiffChart({ o }: { o: ExperimentOutcome }) {
  if (!o.diff) return null;
  const rows = CHART_METRICS.map((m) => {
    const base = o.summaryBase[m].mean;
    const d = o.diff![m];
    const pct = (x: number) => (100 * x) / Math.abs(base);
    const ok = Number.isFinite(d.mean) && Number.isFinite(base) && base !== 0;
    return { m, ok, mean: ok ? pct(d.mean) : 0, lo: ok && Number.isFinite(d.lo) ? pct(d.lo) : NaN, hi: ok && Number.isFinite(d.hi) ? pct(d.hi) : NaN, sig: excludesZero(d) };
  });
  const extent = niceMax(Math.max(1, ...rows.flatMap((r) => [Math.abs(r.mean), Math.abs(r.lo) || 0, Math.abs(r.hi) || 0])));
  const W = 300;
  const L = 78; // label column
  const R = 12;
  const rowH = 24;
  const top = 6;
  const H = top + rows.length * rowH + 20;
  const x = (p: number) => L + ((p + extent) / (2 * extent)) * (W - L - R);
  const aria = `Paired difference, ${o.variantLabel} minus ${o.baseLabel}, as percent of the ${o.baseLabel} mean with 95% intervals: ${rows
    .map((r) => `${SHORT[r.m]} ${r.ok ? `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(1)}%` : 'not available'}`)
    .join('; ')}.`;
  return (
    <figure className="rounded-md border border-border bg-surface-2 p-2">
      <svg data-testid="diff-chart" role="img" aria-label={aria} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
        <line x1={x(0)} x2={x(0)} y1={top - 2} y2={H - 18} className="stroke-muted" strokeWidth={1} strokeDasharray="3 3" />
        {rows.map((r, i) => {
          const y = top + i * rowH + rowH / 2;
          const cls = r.sig ? 'fill-accent stroke-accent' : 'fill-muted stroke-muted';
          return (
            <g key={r.m}>
              <text x={0} y={y + 4} className="fill-text" fontSize={11}>
                {SHORT[r.m]}
              </text>
              {r.ok && Number.isFinite(r.lo) && (
                <line x1={x(Math.max(r.lo, -extent))} x2={x(Math.min(r.hi, extent))} y1={y} y2={y} className={cls} strokeWidth={2} />
              )}
              {r.ok && <circle cx={x(r.mean)} cy={y} r={4} className={cls} />}
            </g>
          );
        })}
        {[-extent, 0, extent].map((p) => (
          <text key={p} x={x(p)} y={H - 4} textAnchor={p === -extent ? 'start' : p === extent ? 'end' : 'middle'} className="fill-muted" fontSize={10}>
            {p > 0 ? '+' : p < 0 ? '−' : ''}
            {Math.abs(p)}%
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 text-[11px] text-muted">
        {o.variantLabel} − {o.baseLabel}, as % of the {o.baseLabel} mean, with 95% intervals. Highlighted where the interval excludes 0.
      </figcaption>
    </figure>
  );
}
