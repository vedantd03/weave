import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PRESETS } from '@weave/engine';
import { SimController } from './state/controller.ts';
import { CLASS_COLORS } from './render/palette.ts';
import { ScenarioForm } from './ui/ScenarioForm.tsx';
import { LiveCharts } from './charts/LiveCharts.tsx';

const SPEEDS = [1, 2, 5, 10, 30, 60];

function useController(): SimController {
  const [ctrl] = useState(() => new SimController());
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('test')) ctrl.installTestHook();
  }, [ctrl]);
  return ctrl;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h2>
      {children}
    </section>
  );
}

function StatTile({ label, value, unit, testId }: { label: string; value: string; unit?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl text-text">
        <span data-testid={testId}>{value}</span>
        {unit && <span className="ml-1 text-xs text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const { primary, className = '', ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-accent text-accent-ink hover:brightness-110'
          : 'border border-border bg-surface-2 text-text hover:bg-border'
      } ${className}`}
    />
  );
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export default function App() {
  const ctrl = useController();
  const st = useSyncExternalStore(ctrl.subscribe, ctrl.getState);
  const canvasRef = useCallback((el: HTMLCanvasElement | null) => ctrl.attachCanvas(el), [ctrl]);
  const presets = useMemo(() => Object.entries(PRESETS), []);

  const loaded = st.status === 'ready' || st.status === 'playing';
  const playing = st.status === 'playing';
  const meanKmh = st.metrics ? (st.metrics.meanSpeedMps * 3.6).toFixed(1) : '—';
  const network = st.network;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight">Weave</span>
        </div>

        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="sr-only">Scenario</span>
          <select
            aria-label="Scenario"
            className="h-9 min-w-0 max-w-[16rem] rounded-md border border-border bg-surface-2 px-2 text-sm text-text"
            value={st.presetId ?? ''}
            disabled={st.status === 'starting' || st.status === 'loading'}
            onChange={(e) => void ctrl.load(e.target.value)}
          >
            <option value="" disabled>
              Choose a scenario…
            </option>
            {presets.map(([id, p]) => (
              <option key={id} value={id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span data-testid="sim-time" className="font-mono text-sm tabular-nums text-muted" title={`${st.t.toFixed(1)} s`}>
            t = {st.t.toFixed(1)} s
          </span>
          <IconButton
            primary
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!loaded}
            onClick={() => (playing ? ctrl.pause() : ctrl.play())}
            className="w-20"
          >
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><rect x="2" y="1.5" width="3.5" height="11" rx="1" fill="currentColor" /><rect x="8.5" y="1.5" width="3.5" height="11" rx="1" fill="currentColor" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 1.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>
            )}
            {playing ? 'Pause' : 'Play'}
          </IconButton>
          <IconButton aria-label="Step" disabled={!loaded} onClick={() => void ctrl.step(1)}>
            Step
          </IconButton>
          <select
            aria-label="Simulation speed"
            className="h-9 rounded-md border border-border bg-surface-2 px-2 text-sm text-text"
            value={st.speed}
            onChange={(e) => ctrl.setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="order-2 shrink-0 overflow-y-auto border-border bg-surface md:order-1 md:w-80 md:border-r">
          <Panel title="Scenario">
            {st.scenario ? (
              <div className="space-y-3">
                <div className="text-sm">
                  <p className="font-medium text-text">{st.scenario.name}</p>
                  {network && (
                    <p className="text-muted">
                      {network.links.length} link{network.links.length === 1 ? '' : 's'} · {network.movements.length} movement
                      {network.movements.length === 1 ? '' : 's'} · seed {st.seed}
                    </p>
                  )}
                </div>
                <ScenarioForm ctrl={ctrl} scenario={st.scenario} />
              </div>
            ) : (
              <p className="text-sm text-muted">Choose a scenario from the menu above.</p>
            )}
          </Panel>
          <Panel title="Vehicle classes">
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {st.classes.classes.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <span className="h-2.5 w-4 rounded-sm" style={{ background: CLASS_COLORS[c.id].dark }} />
                  <span className="text-muted">{CLASS_COLORS[c.id].label}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>

        <main className="relative order-1 min-h-[55vh] flex-1 bg-ground md:order-2 md:min-h-0" aria-label="Simulation view">
          <canvas
            ref={canvasRef}
            data-testid="sim-canvas"
            className="absolute inset-0 h-full w-full touch-none"
            aria-label="Road network and vehicles. Drag to pan, scroll or pinch to zoom, double-click to fit."
          />
          {!loaded && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
              <div className="max-w-sm">
                <p className="text-base font-medium text-text">
                  {st.status === 'loading' ? 'Building scenario…' : 'No scenario loaded'}
                </p>
                <p className="mt-1 text-sm text-muted">
                  Choose a scenario, then press Play. Vehicles are simulated in your browser.
                </p>
              </div>
            </div>
          )}
          {loaded && (
            <button
              type="button"
              onClick={() => ctrl.fitView()}
              className="absolute right-3 bottom-3 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-muted backdrop-blur hover:text-text"
            >
              Fit view
            </button>
          )}
        </main>

        <aside className="order-3 shrink-0 overflow-y-auto border-border bg-surface md:w-72 md:border-l">
          <Panel title="Live metrics">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Time" value={formatTime(st.t)} />
              <StatTile label="Vehicles" value={String(st.vehicles)} testId="stat-vehicles" />
              <StatTile label="Mean speed" value={meanKmh} unit="km/h" testId="stat-mean-speed" />
              <StatTile label="Entry queue" value={st.metrics ? String(st.metrics.entryQueue) : '—'} unit="veh" testId="stat-entry-queue" />
              <StatTile
                label="Throughput"
                value={st.series.length ? st.series[st.series.length - 1]!.exitFlowVph.toFixed(0) : '—'}
                unit="veh/h"
                testId="stat-throughput"
              />
              <StatTile label="Exited" value={st.metrics ? String(st.metrics.exited) : '—'} />
            </div>
          </Panel>
          <Panel title="Over time (1-minute windows)">
            <LiveCharts rows={st.series} />
          </Panel>
        </aside>
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-surface px-4 text-xs text-muted">
        <span data-testid="worker-status" className="flex shrink-0 items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${st.status === 'error' ? 'bg-danger' : st.status === 'starting' ? 'bg-muted' : 'bg-ok'}`} />
          {st.status === 'starting' && 'Starting engine worker…'}
          {st.status === 'error' && `Error: ${st.error}`}
          {st.status !== 'starting' && st.status !== 'error' && `Engine worker ready · ${st.workerPingMs?.toFixed(1) ?? '–'} ms`}
        </span>
        <span className="hidden shrink-0 font-mono sm:inline" title="Deployed commit">
          build <span data-testid="build-commit">{__WEAVE_COMMIT__}</span>
        </span>
        {st.stateHash && (
          <span className="ml-auto truncate font-mono" title="Deterministic state hash: identical seeds give identical hashes in every browser">
            state <span data-testid="state-hash">{st.stateHash}</span>
          </span>
        )}
      </footer>
    </div>
  );
}
