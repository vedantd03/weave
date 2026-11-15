import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeDiff,
  ExperimentFile,
  METRIC_LABELS,
  METRICS,
  pairable,
  RunExport,
  sweepParams,
  sweepValues,
  type Network,
  type ScenarioInput,
} from '@weave/engine';
import type { SimController } from '../state/controller.ts';
import {
  Cancelled,
  cancelExperiment,
  estimateRunMs,
  FLAG_IDS,
  FLYOVER_VARIANTS,
  flyoverVariant,
  fromFile,
  junctionParams,
  runDesign,
  runsOf,
  saveToHistory,
  toFile,
  type ExperimentDesign,
} from '../state/experiment.ts';
import { getExp, setExp, useExp } from '../state/expStore.ts';
import { Segmented } from './MapOverlay.tsx';
import { ExperimentResults } from './ExperimentResults.tsx';
import { ExperimentHistory } from './ExperimentHistory.tsx';

/** Experiments for traffic studies: Replicate, Compare, Sweep (docs/MODEL.md §7.4). */

const field = 'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text tabular-nums';
export const btn = 'h-8 rounded-md border border-border bg-surface-2 px-2.5 text-xs font-medium text-text hover:bg-border disabled:cursor-not-allowed disabled:opacity-40';

function NumIn({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  const id = `exp-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="block text-xs text-muted">
      {label}
      <input id={id} type="number" className={`${field} mt-1`} value={Number.isFinite(value) ? value : ''} step={step} min={min} max={max} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
    </label>
  );
}

export const fmtS = (ms: number) => {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};

/** The design described by the current settings, or the reason there is none. */
function buildDesign(scenario: ScenarioInput, network: Network | null): { design: ExperimentDesign | null; problem: string | null } {
  const s = getExp();
  const durationS = (s.durationMin ?? scenario.durationS / 60) * 60;
  const warmupS = (s.warmupMin ?? (scenario.warmupS ?? 300) / 60) * 60;
  if (!(s.reps >= 1 && s.reps <= 100 && Number.isInteger(s.reps))) return { design: null, problem: 'Replications must be a whole number from 1 to 100.' };
  if (!(durationS > warmupS)) return { design: null, problem: 'Duration must be longer than the warm-up.' };
  const common = { reps: s.reps, durationS, warmupS, metrics: s.metrics };
  if (s.type === 'replicate') return { design: { type: 'replicate', name: `Replicate · ${scenario.name}`, scenario, ...common }, problem: null };
  if (s.type === 'compare') {
    if (s.compare.length < 2) return { design: null, problem: 'Set a baseline and add at least one variant.' };
    return { design: { type: 'compare', name: `Compare · ${s.compare.map((c) => c.name).join(' vs ')}`, scenarios: s.compare, ...common }, problem: null };
  }
  const p = sweepParams(scenario, network ?? undefined).find((q) => q.id === s.sweep.param);
  if (!p) return { design: null, problem: 'Choose a parameter to sweep.' };
  let values: (number | string)[];
  if (p.kind === 'choice') {
    values = s.sweep.choices.length ? s.sweep.choices : (p.choices ?? []).map((c) => c.value);
  } else {
    if (!(s.sweep.steps >= 1 && s.sweep.steps <= 10 && Number.isInteger(s.sweep.steps))) return { design: null, problem: 'Steps must be 1 to 10.' };
    values = sweepValues(s.sweep.from, s.sweep.to, s.sweep.steps).map((v) => Math.round(v * 1e6) / 1e6);
  }
  if (values.length < 1) return { design: null, problem: 'Choose at least one value.' };
  return { design: { type: 'sweep', name: `Sweep · ${p.label} · ${scenario.name}`, scenario, param: p.id, values, ...common }, problem: null };
}

export function ExperimentPanel({ ctrl, scenario, network }: { ctrl: SimController; scenario: ScenarioInput; network: Network | null }) {
  const st = useExp();
  const net = network ?? undefined;
  const params = useMemo(() => sweepParams(scenario, net), [scenario, net]);
  const { design, problem } = buildDesign(scenario, network);
  const runs = design ? runsOf(design) : 0;
  const [variantName, setVariantName] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Sweep defaults when the parameter list changes.
  useEffect(() => {
    const cur = getExp().sweep;
    if (params.some((p) => p.id === cur.param)) return;
    const p = params[0];
    if (p) setExp({ sweep: { param: p.id, from: p.from ?? 0, to: p.to ?? 0, steps: 3, choices: [] } });
  }, [params]);

  // Timing probe for the estimate (debounced; re-run when the cost per run could change).
  const estimateKey = design ? JSON.stringify([design.type === 'compare' ? design.scenarios[0]!.scenario.id : scenario.id, (scenario.od ?? []).length, design.durationS, network?.links.length]) : '';
  useEffect(() => {
    if (!design || st.running || getExp().estimate?.key === estimateKey) return;
    const t = setTimeout(() => {
      estimateRunMs(design, net)
        .then((e) => setExp({ estimate: { ...e, key: estimateKey } }))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, st.running]);

  const run = async (d: ExperimentDesign | null = design) => {
    if (!d) return;
    setExp({ running: true, progress: { done: 0, total: runsOf(d), meanRunMs: 0, workers: getExp().estimate?.workers ?? 1 }, startedAt: performance.now(), error: null, result: null });
    try {
      const r = await runDesign(d, net, (p) => setExp({ progress: p }));
      setExp({ result: r, running: false, history: saveToHistory(toFile(r)) });
    } catch (e) {
      setExp({ running: false, progress: null, error: e instanceof Cancelled ? 'Cancelled. Partial results were discarded.' : e instanceof Error ? e.message : String(e) });
    }
  };

  const importFile = async (file: File) => {
    setExp({ importStatus: null, error: null });
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setExp({ importStatus: 'Not a JSON file.' });
      return;
    }
    const exp = ExperimentFile.safeParse(json);
    if (exp.success) {
      const raw = json as { name: string; design: ExperimentDesign };
      const d = raw.design;
      setExp({
        type: d.type,
        reps: d.reps,
        durationMin: d.durationS / 60,
        warmupMin: d.warmupS / 60,
        metrics: (d.metrics?.length ? d.metrics : getExp().metrics) as ReturnType<typeof getExp>['metrics'],
        ...(d.type === 'compare' ? { compare: d.scenarios } : {}),
        importStatus: `Imported experiment "${raw.name}". Rerunning it…`,
      });
      const base = d.type === 'compare' ? d.scenarios[0]!.scenario : d.scenario;
      if (base.network.kind === 'file' && !network) await ctrl.loadScenario(base);
      const previous = fromFile(raw as never, net);
      await run(d);
      const now = getExp().result;
      if (previous && now) {
        const same = previous.groups.every((g, i) =>
          g.runs.every((r, j) =>
            METRICS.every((m) => {
              const a = r.metrics[m];
              const b = now.groups[i]?.runs[j]?.metrics[m] ?? NaN;
              return (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
            }),
          ),
        );
        setExp({ importStatus: `Reran "${raw.name}": results ${same ? 'match the file exactly' : 'differ from the file'}.` });
      } else if (now) setExp({ importStatus: `Ran imported experiment "${raw.name}".` });
      return;
    }
    const runExp = RunExport.safeParse(json);
    if (runExp.success) {
      const r = runExp.data;
      setExp({ importStatus: `Rerunning the exported run (${r.manifest.steps} steps)…` });
      await ctrl.loadScenario((json as { scenario: ScenarioInput }).scenario);
      let left = r.manifest.steps;
      while (left > 0) {
        const n = Math.min(left, 50_000);
        await ctrl.step(n);
        left -= n;
      }
      const hash = ctrl.getState().stateHash;
      setExp({
        importStatus:
          hash === r.manifest.finalStateHash
            ? `Rerun of the exported run: hash matches (${hash} at t = ${r.manifest.simulatedTimeS.toFixed(1)} s).`
            : `Rerun of the exported run: hash differs (${hash}; the file says ${r.manifest.finalStateHash}).`,
      });
      return;
    }
    setExp({ importStatus: 'Not a Weave experiment or run export.' });
  };

  const eta = (() => {
    const p = st.progress;
    if (!p || !st.running) return null;
    const left = p.total - p.done;
    const perRun = p.done > 0 ? p.meanRunMs : (st.estimate?.perRunMs ?? 0);
    return perRun > 0 ? (left * perRun) / Math.max(1, p.workers) : null;
  })();

  const baseline = st.compare[0]?.scenario;
  const isJunction = baseline ? Boolean(junctionParams(baseline)) : false;
  const sweepParam = params.find((p) => p.id === st.sweep.param);
  const metricChoices = METRICS.filter((m) => !FLAG_IDS.has(m));

  return (
    <div className="space-y-3">
      <Segmented
        label="Experiment type"
        value={st.type}
        options={[
          { value: 'replicate', label: 'Replicate' },
          { value: 'compare', label: 'Compare' },
          { value: 'sweep', label: 'Sweep' },
        ]}
        onChange={(type) => setExp({ type })}
      />
      <p className="text-xs text-muted">
        {st.type === 'replicate' && 'Runs the loaded scenario over N seeds and reports means with 95% Student-t intervals.'}
        {st.type === 'compare' && 'Set a baseline, edit anything in the scenario form and Apply, then add it as a named variant. Seeds are paired when arrivals line up.'}
        {st.type === 'sweep' && 'Varies one parameter of the loaded scenario. The same seeds are used at every point.'}
      </p>

      {st.type === 'compare' && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <button type="button" className={btn} onClick={() => setExp({ compare: [{ name: 'Baseline', scenario }] })}>
            Set as baseline
          </button>
          {st.compare.length > 0 && (
            <>
              <ul className="space-y-1.5" data-testid="compare-scenarios">
                {st.compare.map((c, i) => {
                  const diff = i === 0 ? [] : describeDiff(st.compare[0]!.scenario, c.scenario, net);
                  const pr = i === 0 ? null : pairable(st.compare[0]!.scenario, c.scenario);
                  return (
                    <li key={`${c.name}-${i}`} className="rounded border border-border bg-surface-2 p-2 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-text">
                          {i === 0 ? 'Baseline: ' : ''}
                          {i === 0 ? c.scenario.name : c.name}
                        </span>
                        <button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${c.name}`} onClick={() => setExp((s) => ({ compare: s.compare.filter((_, j) => j !== i) }))}>
                          Remove
                        </button>
                      </div>
                      {i > 0 && (
                        <>
                          <p className="mt-0.5 text-text">{diff.length ? diff.join('; ') : 'Same as the baseline.'}</p>
                          <p className="mt-0.5 text-muted">{pr?.paired ? 'Paired by seed (same zones and OD pairs).' : `Unpaired (Welch): ${pr && !pr.paired ? pr.reason : ''}.`}</p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2">
                <input aria-label="Variant name" className={field} placeholder={`Variant ${st.compare.length}`} value={variantName} onChange={(e) => setVariantName(e.target.value)} />
                <button
                  type="button"
                  className={`${btn} shrink-0`}
                  onClick={() => {
                    setExp((s) => ({ compare: [...s.compare, { name: variantName.trim() || `Variant ${s.compare.length}`, scenario }] }));
                    setVariantName('');
                  }}
                >
                  Add as variant
                </button>
              </div>
              {isJunction && (
                <div className="flex flex-wrap gap-1.5" aria-label="One-click flyover variants">
                  {FLYOVER_VARIANTS.filter((v) => (junctionParams(baseline!)?.flyover?.enabled ? v.id === 'flyover-off' : v.id !== 'flyover-off')).map((v) => (
                    <button key={v.id} type="button" className={btn} onClick={() => setExp((s) => ({ compare: [...s.compare, { name: v.label, scenario: flyoverVariant(s.compare[0]!.scenario, v.id) }] }))}>
                      {v.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {st.type === 'sweep' && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <label htmlFor="exp-sweep-param" className="block text-xs text-muted">
            Parameter
            <select
              id="exp-sweep-param"
              className={`${field} mt-1`}
              value={st.sweep.param}
              onChange={(e) => {
                const p = params.find((q) => q.id === e.target.value);
                if (p) setExp({ sweep: { param: p.id, from: p.from ?? 0, to: p.to ?? 0, steps: 3, choices: [] } });
              }}
            >
              {params.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label.replace(/ \(×.*\)$/, '')}
                  {p.unit && p.unit !== '×' ? ` (${p.unit})` : ''}
                </option>
              ))}
            </select>
          </label>
          {sweepParam && <p className="text-xs text-muted">Now: {typeof sweepParam.current === 'number' ? Math.round(sweepParam.current * 100) / 100 : sweepParam.current}{sweepParam.unit && sweepParam.unit !== '×' ? ` ${sweepParam.unit}` : sweepParam.id === 'demandScale' ? ` (${sweepParam.label.match(/\(× (.*)\)/)?.[1] ?? ''})` : ''}</p>}
          {sweepParam?.kind === 'number' && (
            <div className="grid grid-cols-3 gap-2">
              <NumIn label="From" value={st.sweep.from} step={0.1} onChange={(v) => setExp((s) => ({ sweep: { ...s.sweep, from: v } }))} />
              <NumIn label="To" value={st.sweep.to} step={0.1} onChange={(v) => setExp((s) => ({ sweep: { ...s.sweep, to: v } }))} />
              <NumIn label="Steps" value={st.sweep.steps} min={1} max={10} onChange={(v) => setExp((s) => ({ sweep: { ...s.sweep, steps: Math.round(v) } }))} />
            </div>
          )}
          {sweepParam?.kind === 'choice' && (
            <div className="flex gap-3 text-xs">
              {(sweepParam.choices ?? []).map((c) => {
                const chosen = st.sweep.choices.length ? st.sweep.choices : (sweepParam.choices ?? []).map((x) => x.value);
                return (
                  <label key={c.value} className="flex items-center gap-1.5 text-text">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.value)}
                      onChange={(e) => setExp((s) => ({ sweep: { ...s.sweep, choices: e.target.checked ? [...chosen, c.value] : chosen.filter((x) => x !== c.value) } }))}
                    />
                    {c.label}
                  </label>
                );
              })}
            </div>
          )}
          {design?.type === 'sweep' && <p className="text-xs text-muted">Values: {design.values.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)).join(', ')}</p>}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <label htmlFor="exp-reps" className="block text-xs text-muted">
          {st.type === 'sweep' ? 'Reps per point' : 'Replications'}
          <input id="exp-reps" aria-label="Replications" type="number" min={1} max={100} className={`${field} mt-1`} value={st.reps} onChange={(e) => e.target.value !== '' && setExp({ reps: Math.round(Number(e.target.value)) })} />
        </label>
        <NumIn label="Duration per run (min)" value={st.durationMin ?? scenario.durationS / 60} min={1} onChange={(v) => setExp({ durationMin: v })} />
        <NumIn label="Warm-up per run (min)" value={st.warmupMin ?? (scenario.warmupS ?? 300) / 60} min={0} onChange={(v) => setExp({ warmupMin: v })} />
      </div>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted">Metrics shown · {st.metrics.length} chosen (stability flags always shown)</summary>
        <div className="grid grid-cols-1 gap-1 px-2 pb-2 text-xs sm:grid-cols-2">
          {metricChoices.map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-text">
              <input type="checkbox" checked={st.metrics.includes(m)} onChange={(e) => setExp((s) => ({ metrics: e.target.checked ? [...s.metrics, m] : s.metrics.filter((x) => x !== m) }))} />
              {METRIC_LABELS[m].label}
            </label>
          ))}
        </div>
      </details>

      <p data-testid="experiment-estimate" className="text-xs text-muted">
        {problem ??
          `${runs} run${runs === 1 ? '' : 's'}${
            st.estimate
              ? ` × ~${fmtS(st.estimate.perRunMs)} per run ≈ ${fmtS(runs * st.estimate.perRunMs)} of computing, about ${fmtS((runs * st.estimate.perRunMs) / st.estimate.workers)} on ${st.estimate.workers} worker${st.estimate.workers === 1 ? '' : 's'} (estimate)`
              : ' (timing estimate…)'
          }`}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!design || st.running}
          onClick={() => void run()}
          className="h-9 flex-1 rounded-md bg-accent text-sm font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Run experiment
        </button>
        {st.running && (
          <button type="button" className="h-9 rounded-md border border-danger/50 px-3 text-sm text-danger hover:bg-danger/10" onClick={() => cancelExperiment()}>
            Cancel
          </button>
        )}
      </div>
      {st.progress && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <progress className="h-1.5 flex-1" max={st.progress.total} value={st.progress.done} aria-label="Experiment progress" />
          <span data-testid="experiment-progress" className="font-mono">
            {st.progress.done} / {st.progress.total}
          </span>
          {st.running && (
            <span data-testid="experiment-eta" className="font-mono">
              {eta !== null ? `~${fmtS(eta)} left` : 'estimating…'}
            </span>
          )}
        </div>
      )}
      {st.error && (
        <p role="alert" className="text-xs text-danger">
          {st.error}
        </p>
      )}

      {st.result && <ExperimentResults result={st.result} metrics={st.metrics} network={net} />}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <button type="button" className={btn} onClick={() => fileInput.current?.click()}>
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="Import experiment or run JSON"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
        <span className="text-xs text-muted">an exported experiment (reruns it) or run (replays it and checks its hash)</span>
      </div>
      {st.importStatus && (
        <p role="status" data-testid="import-status" className="text-xs text-text">
          {st.importStatus}
        </p>
      )}

      <ExperimentHistory network={net} />
    </div>
  );
}
