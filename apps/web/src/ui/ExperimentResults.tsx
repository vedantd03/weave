import { useMemo, useState } from 'react';
import { meanCI, METRIC_LABELS, type CI, type MetricId, type Network } from '@weave/engine';
import { FLAGS, toCsv, toFile, type ExperimentResult, type GroupResult } from '../state/experiment.ts';

/** Results of an experiment (docs/MODEL.md §7.4): summary, tables, charts, breakdowns, export. */

const btn = 'h-8 rounded-md border border-border bg-surface-2 px-2.5 text-xs font-medium text-text hover:bg-border';

const num = (x: number, d = 1) => {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const s = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toFixed(a >= 100 ? 0 : d);
  return x < 0 ? `−${s}` : s;
};
const ci = (c: CI | undefined, d = 1) => (!c || !Number.isFinite(c.mean) ? '—' : Number.isFinite(c.half) ? `${num(c.mean, d)} ± ${num(c.half, d)}` : num(c.mean, d));
const range = (c: CI, unit: string) => (Number.isFinite(c.half) ? `95% CI ${num(c.lo)} to ${num(c.hi)}${unit ? ` ${unit}` : ''}` : 'no interval');
const excludesZero = (c: CI | undefined) => Boolean(c && Number.isFinite(c.lo) && (c.lo > 0 || c.hi < 0));
const flagCount = (g: GroupResult, m: MetricId) => g.runs.filter((r) => r.metrics[m] > 0).length;
const problem = (g: GroupResult) => FLAGS.some((f) => flagCount(g, f.metric) > 0);
const short = (m: MetricId) => METRIC_LABELS[m].label.split(',')[0]!.replace(/ \(.*\)$/, '');

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- plain-English summary ---------------- */

function flagsSentence(r: ExperimentResult): string {
  const parts = FLAGS.map((f) => {
    const hit = r.groups.filter((g) => flagCount(g, f.metric) > 0);
    if (!hit.length) return null;
    const total = hit.reduce((a, g) => a + flagCount(g, f.metric), 0);
    const where = r.groups.length > 1 ? ` (${hit.map((g) => g.label).join(', ')})` : '';
    return `${total} run${total === 1 ? '' : 's'} ${f.metric === 'gridlocked' ? 'ended gridlocked' : f.metric === 'queueGrowing' ? 'still had a growing entry queue' : 'were still filling up inside the network'}${where}`;
  }).filter(Boolean);
  return parts.length ? `Stability: ${parts.join('; ')}. Those runs had not reached a steady state.` : 'Every run was stable: no gridlock, and neither entry queues nor the network were still growing.';
}

export function summaryText(r: ExperimentResult, primary: MetricId): string {
  const { label, unit } = METRIC_LABELS[primary];
  const name = label.split(',')[0]!.toLowerCase().replace(/ \(.*\)$/, '');
  const n = r.design.reps;
  const g0 = r.groups[0]!;
  if (r.design.type === 'replicate') {
    const tp = g0.summary.throughputVph;
    return `Over ${n} seed${n === 1 ? '' : 's'}, ${name} was ${num(g0.summary[primary].mean)} ${unit} (${range(g0.summary[primary], unit)}) and throughput ${num(tp.mean)} veh/h. ${flagsSentence(r)}`;
  }
  if (r.design.type === 'compare') {
    const head = `Over ${n} seed${n === 1 ? '' : 's'} per scenario, the baseline (${g0.label}) had ${name} ${num(g0.summary[primary].mean)} ${unit} (${range(g0.summary[primary], unit)}).`;
    const lines = r.groups.slice(1).map((g) => {
      const d = g.diff![primary];
      const how = g.paired ? 'paired by seed' : `Welch, unpaired: ${g.pairingNote?.replace(/^Welch \(unpaired\): /, '') ?? ''}`;
      if (!excludesZero(d)) return `${g.label}: no clear difference (${d.mean >= 0 ? '+' : ''}${num(d.mean)} ${unit}, ${range(d, unit)}; ${how}).`;
      return `${g.label}: ${name} ${d.mean > 0 ? 'rose' : 'fell'} by ${num(Math.abs(d.mean))} ${unit} (${range(d.mean > 0 ? d : { ...d, lo: -d.hi, hi: -d.lo }, unit)}; ${how}).`;
    });
    return `${head} ${lines.join(' ')} ${flagsSentence(r)}`;
  }
  const means = r.groups.map((g) => g.summary[primary].mean);
  const best = means.indexOf(Math.min(...means.filter(Number.isFinite)));
  const bad = r.groups.filter(problem).map((g) => g.label);
  return `Sweeping ${r.groups[0]!.label.split(' = ')[0]} over ${r.groups.length} point${r.groups.length === 1 ? '' : 's'} (${n} seed${n === 1 ? '' : 's'} each, the same seeds at every point): ${name} went from ${num(means[0]!)} ${unit} at ${r.groups[0]!.label.split(' = ')[1]} to ${num(means[means.length - 1]!)} ${unit} at ${r.groups[r.groups.length - 1]!.label.split(' = ')[1]}; lowest ${num(means[best] ?? NaN)} ${unit} at ${r.groups[best]?.label.split(' = ')[1] ?? '—'}. ${bad.length ? `Problem points (gridlock or still growing): ${bad.map((b) => b.split(' = ')[1]).join(', ')}.` : 'No problem points.'} ${flagsSentence(r)}`;
}

/* ---------------- charts ---------------- */

function CompareChart({ r, m }: { r: ExperimentResult; m: MetricId }) {
  const rows = r.groups.map((g) => ({ label: g.label, c: g.summary[m], bad: problem(g) }));
  const vals = rows.flatMap((x) => [x.c.lo, x.c.hi, x.c.mean]).filter(Number.isFinite);
  if (!vals.length) return null;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  lo -= pad;
  hi += pad;
  const W = 300;
  const L = 96;
  const rowH = 22;
  const H = rows.length * rowH + 22;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - 10);
  return (
    <svg data-testid="compare-chart" role="img" aria-label={`${short(m)} by scenario with 95% intervals: ${rows.map((x) => `${x.label} ${num(x.c.mean)}`).join('; ')}`} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
      {rows.map((row, i) => {
        const y = 4 + i * rowH + rowH / 2;
        const cls = i === 0 ? 'fill-muted stroke-muted' : 'fill-accent stroke-accent';
        return (
          <g key={row.label}>
            <text x={0} y={y + 3.5} fontSize={10} className="fill-text">
              {row.label.length > 16 ? `${row.label.slice(0, 15)}…` : row.label}
            </text>
            {Number.isFinite(row.c.lo) && <line x1={x(row.c.lo)} x2={x(row.c.hi)} y1={y} y2={y} strokeWidth={2} className={cls} />}
            {Number.isFinite(row.c.mean) && <circle cx={x(row.c.mean)} cy={y} r={3.5} className={cls} />}
            {row.bad && (
              <text x={W - 2} y={y + 3.5} fontSize={10} textAnchor="end" className="fill-danger">
                !
              </text>
            )}
          </g>
        );
      })}
      {[lo, (lo + hi) / 2, hi].map((v, i) => (
        <text key={i} x={x(v)} y={H - 4} fontSize={9} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="fill-muted">
          {num(v)}
        </text>
      ))}
    </svg>
  );
}

function SweepChart({ r, m }: { r: ExperimentResult; m: MetricId }) {
  const pts = r.groups.map((g, i) => ({ g, xv: typeof g.value === 'number' ? g.value : i, c: g.summary[m], bad: problem(g) }));
  const ys = pts.flatMap((p) => [p.c.lo, p.c.hi, p.c.mean]).filter(Number.isFinite);
  if (!ys.length) return null;
  const numeric = pts.every((p) => typeof p.g.value === 'number');
  const xs = pts.map((p) => p.xv);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.1;
  y0 -= pad;
  y1 += pad;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const W = 300;
  const H = 150;
  const L = 36;
  const B = 22;
  const X = (v: number) => (x1 === x0 ? (L + W) / 2 : L + ((v - x0) / (x1 - x0)) * (W - L - 10));
  const Y = (v: number) => 8 + (1 - (v - y0) / (y1 - y0)) * (H - B - 8);
  const ok = pts.filter((p) => Number.isFinite(p.c.lo) && Number.isFinite(p.c.hi));
  const band = ok.length > 1 ? [...ok.map((p) => `${X(p.xv)},${Y(p.c.hi)}`), ...[...ok].reverse().map((p) => `${X(p.xv)},${Y(p.c.lo)}`)].join(' ') : '';
  const line = pts.filter((p) => Number.isFinite(p.c.mean)).map((p) => `${X(p.xv)},${Y(p.c.mean)}`).join(' ');
  return (
    <svg data-testid="sweep-chart" role="img" aria-label={`${short(m)} against the swept parameter with a 95% band: ${pts.map((p) => `${p.g.label.split(' = ')[1]} → ${num(p.c.mean)}${p.bad ? ' (problem)' : ''}`).join('; ')}`} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
      {band && <polygon points={band} className="fill-accent" opacity={0.18} />}
      <polyline points={line} fill="none" strokeWidth={2} className="stroke-accent" />
      {pts.map((p) =>
        Number.isFinite(p.c.mean) ? (
          <g key={p.g.label}>
            <circle cx={X(p.xv)} cy={Y(p.c.mean)} r={3.5} className={p.bad ? 'fill-danger' : 'fill-accent'} />
            {p.bad && <circle cx={X(p.xv)} cy={Y(p.c.mean)} r={7} fill="none" strokeWidth={1.5} className="stroke-danger" />}
          </g>
        ) : null,
      )}
      {[y0, (y0 + y1) / 2, y1].map((v, i) => (
        <text key={i} x={L - 4} y={Y(v) + 3} fontSize={9} textAnchor="end" className="fill-muted">
          {num(v)}
        </text>
      ))}
      {pts.map((p) => (
        <text key={`x${p.g.label}`} x={X(p.xv)} y={H - 6} fontSize={9} textAnchor="middle" className="fill-muted">
          {numeric ? num(p.xv, 2) : String(p.g.value)}
        </text>
      ))}
    </svg>
  );
}

/* ---------------- breakdowns ---------------- */

type Row = Record<string, number | string>;
function aggregate(rows: Row[][], key: (r: Row) => string, fields: string[]): { key: string; first: Row; ci: Record<string, CI> }[] {
  const by = new Map<string, Row[]>();
  for (const runRows of rows) for (const r of runRows) by.set(key(r), [...(by.get(key(r)) ?? []), r]);
  return [...by.entries()].map(([k, rs]) => ({
    key: k,
    first: rs[0]!,
    ci: Object.fromEntries(fields.map((f) => [f, meanCI(rs.map((r) => Number(r[f])).filter(Number.isFinite))])),
  }));
}

function Breakdowns({ r }: { r: ExperimentResult }) {
  const [gi, setGi] = useState(0);
  const g = r.groups[gi] ?? r.groups[0]!;
  const runs = g.runs.filter((x) => x.breakdown);
  const ap = useMemo(() => aggregate(runs.map((x) => x.breakdown!.approaches as unknown as Row[]), (x) => String(x.zone), ['meanDelayS', 'throughputVph', 'meanEntryQueue', 'maxEntryQueue']), [runs]);
  const mv = useMemo(() => aggregate(runs.map((x) => x.breakdown!.movements as unknown as Row[]), (x) => String(x.id), ['flowVph', 'meanTimeS', 'meanDelayS']), [runs]);
  const hasOd = runs.some((x) => x.breakdown!.od);
  const od = useMemo(() => (hasOd ? aggregate(runs.map((x) => (x.breakdown!.od ?? []) as unknown as Row[]), (x) => `${x.origin} → ${x.destination}`, ['meanDelayS', 'meanTravelTimeS', 'completed']) : []), [runs, hasOd]);
  const zone = (z: string) => z.replace(/^arm(\d+)_(in|out)$/, (_, k) => `Arm ${Number(k) + 1}`);
  const th = 'py-1 pr-2 font-medium';
  const td = 'py-1 pr-2 font-mono';
  if (!runs.length) return <p className="text-xs text-muted">Breakdowns are not stored with history entries; rerun the experiment to see them.</p>;
  return (
    <details className="rounded-md border border-border" open>
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted">Breakdowns by approach, movement{hasOd ? ' and OD' : ''} (mean ± 95% CI over {runs.length} seeds)</summary>
      <div className="space-y-2 px-2 pb-2">
        {r.groups.length > 1 && (
          <label className="block text-xs text-muted">
            For
            <select className="ml-2 h-7 rounded border border-border bg-surface-2 px-1 text-xs text-text" value={gi} onChange={(e) => setGi(Number(e.target.value))}>
              {r.groups.map((x, i) => (
                <option key={i} value={i}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="overflow-x-auto">
          <table data-testid="breakdown-approaches" aria-label="By approach" className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted">
              <tr>
                <th className={th}>Approach</th>
                <th className={th}>Delay (s)</th>
                <th className={th}>Throughput (veh/h)</th>
                <th className={th}>Queue mean / max</th>
              </tr>
            </thead>
            <tbody>
              {ap.map((a) => (
                <tr key={a.key} className="border-t border-border">
                  <td className="py-1 pr-2 text-text">{zone(a.key)}</td>
                  <td className={td}>{ci(a.ci.meanDelayS)}</td>
                  <td className={td}>{ci(a.ci.throughputVph, 0)}</td>
                  <td className={td}>
                    {num(a.ci.meanEntryQueue!.mean)} / {num(a.ci.maxEntryQueue!.mean, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mv.length > 0 && (
          <div className="max-h-64 overflow-auto">
            <table data-testid="breakdown-movements" aria-label="By movement" className="w-full text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className={th}>Movement</th>
                  <th className={th}>Flow (veh/h)</th>
                  <th className={th}>Time on it (s)</th>
                  <th className={th}>Trip delay (s)</th>
                </tr>
              </thead>
              <tbody>
                {mv.map((m) => (
                  <tr key={m.key} className="border-t border-border">
                    <td className="max-w-[9rem] truncate py-1 pr-2 font-mono text-text" title={m.key}>
                      {m.key}
                    </td>
                    <td className={td}>{ci(m.ci.flowVph, 0)}</td>
                    <td className={td}>{ci(m.ci.meanTimeS)}</td>
                    <td className={td}>{ci(m.ci.meanDelayS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasOd && (
          <div className="max-h-64 overflow-auto">
            <table data-testid="breakdown-od" aria-label="By origin and destination" className="w-full text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className={th}>OD</th>
                  <th className={th}>Delay (s)</th>
                  <th className={th}>Travel time (s)</th>
                  <th className={th}>Trips</th>
                </tr>
              </thead>
              <tbody>
                {od.map((o) => (
                  <tr key={o.key} className="border-t border-border">
                    <td className="py-1 pr-2 text-text">{o.key.split(' → ').map(zone).join(' → ')}</td>
                    <td className={td}>{ci(o.ci.meanDelayS)}</td>
                    <td className={td}>{ci(o.ci.meanTravelTimeS)}</td>
                    <td className={td}>{num(o.ci.completed!.mean, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

/* ---------------- main ---------------- */

export function ExperimentResults({ result: r, metrics, network: _network }: { result: ExperimentResult; metrics: MetricId[]; network?: Network }) {
  const shown = metrics.length ? metrics : (['meanDelayS'] as MetricId[]);
  const [chartMetric, setChartMetric] = useState<MetricId>(shown[0]!);
  const primary = shown.includes('meanDelayS') ? 'meanDelayS' : shown[0]!;
  const ref = r.groups[0]!;
  const many = r.groups.length > 1;
  const th = 'py-1 pr-2 font-medium';
  const slug = r.name.replace(/[^\w-]+/g, '-').slice(0, 60);
  return (
    <div className="space-y-2">
      <p data-testid="experiment-summary" className="rounded-md border border-border bg-surface-2 p-2.5 text-sm leading-relaxed text-text">
        {summaryText(r, primary)}
      </p>

      {FLAGS.map((f) => {
        const k = r.groups.reduce((a, g) => a + flagCount(g, f.metric), 0);
        const n = r.groups.reduce((a, g) => a + g.runs.length, 0);
        if (!k) return null;
        const what =
          f.metric === 'gridlocked'
            ? 'ended in gridlock (at least one junction locked)'
            : f.metric === 'queueGrowing'
              ? 'still had an entry queue growing at the end: demand exceeds what the network admits'
              : 'were still filling up inside the network at the end (more vehicles entering than leaving)';
        return (
          <div key={f.metric} role="status" className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            {k} of {n} runs {what}. These runs had not reached a steady state; mean delay includes the delay so far of unfinished trips.
          </div>
        );
      })}

      {(r.design.type === 'compare' || r.design.type === 'sweep') && (
        <figure className="rounded-md border border-border bg-surface-2 p-2">
          <label className="mb-1 block text-xs text-muted">
            Chart
            <select className="ml-2 h-7 rounded border border-border bg-surface px-1 text-xs text-text" value={chartMetric} onChange={(e) => setChartMetric(e.target.value as MetricId)}>
              {shown.map((m) => (
                <option key={m} value={m}>
                  {short(m)}
                </option>
              ))}
            </select>
          </label>
          {r.design.type === 'compare' ? <CompareChart r={r} m={chartMetric} /> : <SweepChart r={r} m={chartMetric} />}
          <figcaption className="mt-1 text-[11px] text-muted">
            Mean with 95% Student-t interval per {r.design.type === 'compare' ? 'scenario' : 'point (shaded band)'}.{' '}
            {r.groups.some(problem) ? 'Red marks points where a run gridlocked or was still growing.' : 'No problem points.'}
          </figcaption>
        </figure>
      )}

      <div className="overflow-x-auto">
        <table data-testid="experiment-results" className="w-full text-left text-xs tabular-nums">
          <thead className="text-muted">
            <tr>
              <th className={th}>Metric</th>
              {r.groups.map((g, i) => (
                <th key={i} className={th}>
                  {g.label}
                </th>
              ))}
              {r.design.type === 'compare' && r.groups.slice(1).map((g, i) => <th key={`d${i}`} className={th}>{r.groups.length === 2 ? 'Difference (Δ)' : `Δ ${g.label}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {FLAGS.map((f) => (
              <tr key={f.metric} data-testid={f.testId} className="border-t border-border">
                <td className="py-1 pr-2 text-text" title={f.title}>
                  {f.label}
                </td>
                {r.groups.map((g, i) => (
                  <td key={i} className={`py-1 pr-2 font-mono ${flagCount(g, f.metric) ? 'text-danger' : ''}`}>
                    {flagCount(g, f.metric)} / {g.runs.length}
                  </td>
                ))}
                {r.design.type === 'compare' && r.groups.slice(1).map((_, i) => <td key={`d${i}`} />)}
              </tr>
            ))}
            {shown.map((m) => (
              <tr key={m} className="border-t border-border">
                <td className="py-1 pr-2 text-text">
                  {METRIC_LABELS[m].label}
                  {METRIC_LABELS[m].unit && <span className="text-muted"> ({METRIC_LABELS[m].unit})</span>}
                </td>
                {r.groups.map((g, i) => (
                  <td key={i} className="py-1 pr-2 font-mono">
                    {ci(g.summary[m])}
                  </td>
                ))}
                {r.design.type === 'compare' &&
                  r.groups.slice(1).map((g, i) => (
                    <td key={`d${i}`} className={`py-1 pr-2 font-mono ${excludesZero(g.diff?.[m]) ? 'text-accent' : ''}`} title={g.pairingNote}>
                      {ci(g.diff?.[m])}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.design.type === 'compare' && (
        <ul className="space-y-0.5 text-xs text-muted">
          {r.groups.slice(1).map((g) => (
            <li key={g.label}>
              Δ {g.label} − {ref.label}: {g.paired ? 'paired by seed (common random numbers)' : g.pairingNote}.
            </li>
          ))}
        </ul>
      )}

      {r.design.type === 'sweep' && (
        <div className="overflow-x-auto">
          <table aria-label="Sweep points" data-testid="sweep-points" className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted">
              <tr>
                <th className={th}>Point</th>
                <th className={th}>{short(primary)}</th>
                <th className={th}>Δ vs first</th>
                <th className={th}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 pr-2 text-text">{g.label.split(' = ')[1]}</td>
                  <td className="py-1 pr-2 font-mono">{ci(g.summary[primary])}</td>
                  <td className="py-1 pr-2 font-mono" title={g.pairingNote}>
                    {i === 0 ? '—' : ci(g.diff?.[primary])}
                  </td>
                  <td className={`py-1 pr-2 ${problem(g) ? 'text-danger' : 'text-muted'}`}>
                    {FLAGS.map((f) => `${flagCount(g, f.metric)}`).join(' / ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">Flags: gridlocked / entry queue growing / network still filling, runs out of {r.design.reps}.</p>
        </div>
      )}

      {many && r.design.type === 'replicate' ? null : <Breakdowns r={r} />}

      <div className="flex gap-2">
        <button type="button" className={btn} onClick={() => download(`weave-experiment-${slug}.json`, JSON.stringify(toFile(r), null, 1), 'application/json')}>
          Export JSON
        </button>
        <button type="button" className={btn} onClick={() => download(`weave-experiment-${slug}.csv`, toCsv(r), 'text/csv')}>
          Export CSV
        </button>
      </div>
    </div>
  );
}
