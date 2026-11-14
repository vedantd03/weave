import { useMemo, useState } from 'react';
import { METRICS, METRIC_LABELS, type CI, type Network, type ScenarioInput } from '@weave/engine';
import { compareOptions, runExperiment, toCsv, type CompareId, type ExperimentOutcome } from '../state/experiment.ts';

const field = 'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text tabular-nums';

function fmt(ci: CI | undefined, digits = 1): string {
  if (!ci || !Number.isFinite(ci.mean)) return '—';
  const h = Number.isFinite(ci.half) ? ` ± ${ci.half.toFixed(digits)}` : '';
  return `${ci.mean.toFixed(digits)}${h}`;
}

export function ExperimentPanel({ scenario, network }: { scenario: ScenarioInput; network: Network | null }) {
  const [n, setN] = useState(10);
  const options = useMemo(() => compareOptions(scenario), [scenario]);
  const [cmp, setCmp] = useState<CompareId>('none');
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [outcome, setOutcome] = useState<ExperimentOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null && progress[0] < progress[1];
  const compare = options.some((o) => o.value === cmp) ? cmp : 'none';

  const run = async () => {
    setError(null);
    setOutcome(null);
    setProgress([0, n * (compare === 'none' ? 1 : 2)]);
    try {
      const net = scenario.network.kind === 'file' ? (network ?? undefined) : undefined;
      setOutcome(await runExperiment(scenario, net, n, compare, (d, t) => setProgress([d, t])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  const download = () => {
    if (!outcome) return;
    const blob = new Blob([toCsv(outcome)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `weave-${scenario.id}-${outcome.base.length}x.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Runs independent replications with seeds {scenario.seed}, {scenario.seed + 1}, … in background workers and reports
        means with 95% Student-t intervals. Comparisons are paired by seed (common random numbers).
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="x-reps" className="mb-1 block text-xs text-muted">
            Replications
          </label>
          <input id="x-reps" type="number" min={2} max={100} step="any" className={field} value={n} onChange={(e) => setN(Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))))} />
        </div>
        <div>
          <label htmlFor="x-cmp" className="mb-1 block text-xs text-muted">
            Compare with
          </label>
          <select id="x-cmp" className={field} value={compare} onChange={(e) => setCmp(e.target.value as CompareId)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="button" disabled={running} onClick={() => void run()} className="h-9 w-full rounded-md bg-accent text-sm font-semibold text-accent-ink disabled:opacity-50">
        Run experiment
      </button>
      {progress && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
            <div className="h-full bg-accent transition-all" style={{ width: `${(100 * progress[0]) / Math.max(1, progress[1])}%` }} />
          </div>
          <span data-testid="experiment-progress" className="font-mono">
            {progress[0]} / {progress[1]}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {outcome && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table data-testid="experiment-results" className="w-full text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Metric</th>
                  <th className="py-1 pr-2 font-medium">{outcome.baseLabel}</th>
                  {outcome.variant && <th className="py-1 pr-2 font-medium">{outcome.variantLabel}</th>}
                  {outcome.variant && <th className="py-1 font-medium">Difference (Δ)</th>}
                </tr>
              </thead>
              <tbody>
                <tr data-testid="gridlocked-runs" className="border-t border-border">
                  <td className="py-1 pr-2 text-text">Gridlocked runs</td>
                  <td className="py-1 pr-2 font-mono">
                    {outcome.base.filter((r) => r.metrics.gridlocked > 0).length} / {outcome.base.length}
                  </td>
                  {outcome.variant && (
                    <td className="py-1 pr-2 font-mono">
                      {outcome.variant.filter((r) => r.metrics.gridlocked > 0).length} / {outcome.variant.length}
                    </td>
                  )}
                  {outcome.variant && <td className="py-1" />}
                </tr>
                {METRICS.filter((m) => m !== 'gridlocked').map((m) => {
                  const d = outcome.diff?.[m];
                  const sig = d && Number.isFinite(d.lo) && (d.lo > 0 || d.hi < 0);
                  return (
                    <tr key={m} className="border-t border-border">
                      <td className="py-1 pr-2 text-text">
                        {METRIC_LABELS[m].label}
                        {METRIC_LABELS[m].unit && <span className="text-muted"> ({METRIC_LABELS[m].unit})</span>}
                      </td>
                      <td className="py-1 pr-2 font-mono">{fmt(outcome.summaryBase[m])}</td>
                      {outcome.variant && <td className="py-1 pr-2 font-mono">{fmt(outcome.summaryVariant?.[m])}</td>}
                      {outcome.variant && <td className={`py-1 font-mono ${sig ? 'text-accent' : ''}`}>{fmt(d)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(() => {
            const all = [...outcome.base, ...(outcome.variant ?? [])];
            const k = all.filter((r) => r.metrics.gridlocked > 0).length;
            return k > 0 ? (
              <div role="status" className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
                {k} of {all.length} runs ended in gridlock (at least one junction locked). Mean delay includes the delay
                accumulated so far by trips that never finished.
              </div>
            ) : null;
          })()}
          {outcome.variant && (
            <p className="text-xs text-muted">
              Δ = {outcome.variantLabel} − {outcome.baseLabel}, paired by seed. Highlighted when the 95% interval excludes 0.
            </p>
          )}
          <button type="button" onClick={download} className="h-8 w-full rounded-md border border-border bg-surface-2 text-sm text-text hover:bg-border">
            Download CSV
          </button>
        </div>
      )}
    </div>
  );
}
