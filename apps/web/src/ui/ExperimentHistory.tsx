import { useMemo } from 'react';
import { METRIC_LABELS, welchCI, type MetricId, type Network } from '@weave/engine';
import { deleteFromHistory, FLAGS, fromFile, renameInHistory } from '../state/experiment.ts';
import { setExp, useExp } from '../state/expStore.ts';

/** Saved experiments: open, rename, delete, and compare two side by side (§7.4). */

const btn = 'h-7 rounded border border-border bg-surface-2 px-2 text-[11px] font-medium text-text hover:bg-border';
const PRIMARY: MetricId[] = ['meanDelayS', 'throughputVph', 'meanSpeedKmh', 'maxEntryQueue'];
const num = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)) : '—');

export function ExperimentHistory({ network }: { network?: Network }) {
  const st = useExp();
  const picked = useMemo(
    () => st.picked.map((c) => st.history.find((h) => h.createdAt === c)).filter((h): h is NonNullable<typeof h> => Boolean(h)).map((h) => fromFile(h, network)).filter((r): r is NonNullable<typeof r> => Boolean(r)),
    [st.picked, st.history, network],
  );
  if (!st.history.length) return null;
  return (
    <details className="rounded-md border border-border" open>
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted">History · {st.history.length} saved in this browser</summary>
      <ul data-testid="history-list" className="space-y-1 px-2 pb-2">
        {st.history.map((h) => (
          <li key={h.createdAt} className="rounded border border-border bg-surface-2 p-1.5 text-xs">
            <input
              aria-label="Experiment name"
              className="w-full bg-transparent font-medium text-text outline-none"
              defaultValue={h.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== h.name && setExp({ history: renameInHistory(h.createdAt, e.target.value.trim()) })}
            />
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
              <span>
                {h.design.type} · {h.results?.runs.length ?? 0} runs · {new Date(h.createdAt).toLocaleString()}
              </span>
              <span className="ml-auto flex gap-1">
                <button type="button" className={btn} onClick={() => setExp({ result: fromFile(h, network), error: null })}>
                  Open
                </button>
                <label className="flex items-center gap-1 px-1">
                  <input
                    type="checkbox"
                    checked={st.picked.includes(h.createdAt)}
                    onChange={(e) => setExp((s) => ({ picked: e.target.checked ? [...s.picked.filter((x) => x !== h.createdAt), h.createdAt].slice(-2) : s.picked.filter((x) => x !== h.createdAt) }))}
                  />
                  Compare
                </label>
                <button type="button" className={`${btn} hover:text-danger`} onClick={() => setExp((s) => ({ history: deleteFromHistory(h.createdAt), picked: s.picked.filter((x) => x !== h.createdAt) }))}>
                  Delete
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {picked.length === 2 && (
        <div className="overflow-x-auto px-2 pb-2">
          <table data-testid="history-compare" className="w-full text-left text-xs tabular-nums">
            <caption className="pb-1 text-left text-muted">First scenario or point of each, Welch difference (B − A)</caption>
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Metric</th>
                <th className="py-1 pr-2 font-medium">A: {picked[0]!.name}</th>
                <th className="py-1 pr-2 font-medium">B: {picked[1]!.name}</th>
                <th className="py-1 pr-2 font-medium">B − A</th>
              </tr>
            </thead>
            <tbody>
              {[...PRIMARY, ...FLAGS.map((f) => f.metric)].map((m) => {
                const a = picked[0]!.groups[0]!.runs.map((x) => x.metrics[m]);
                const b = picked[1]!.groups[0]!.runs.map((x) => x.metrics[m]);
                const d = welchCI(a, b);
                const flag = FLAGS.some((f) => f.metric === m);
                return (
                  <tr key={m} className="border-t border-border">
                    <td className="py-1 pr-2 text-text">{METRIC_LABELS[m].label}</td>
                    <td className="py-1 pr-2 font-mono">{flag ? `${a.filter((x) => x > 0).length} / ${a.length}` : num(picked[0]!.groups[0]!.summary[m].mean)}</td>
                    <td className="py-1 pr-2 font-mono">{flag ? `${b.filter((x) => x > 0).length} / ${b.length}` : num(picked[1]!.groups[0]!.summary[m].mean)}</td>
                    <td className="py-1 pr-2 font-mono">{flag ? '' : Number.isFinite(d.half) ? `${num(d.mean)} ± ${num(d.half)}` : num(d.mean)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
