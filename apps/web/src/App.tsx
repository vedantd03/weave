import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PRESETS } from '@weave/engine';
import { SimController } from './state/controller.ts';
import { Legend, Segmented } from './ui/MapOverlay.tsx';
import { InspectCard } from './ui/InspectCard.tsx';
import { RunData } from './ui/RunData.tsx';
import { ScenarioForm } from './ui/ScenarioForm.tsx';
import { LiveCharts } from './charts/LiveCharts.tsx';
import { ExperimentPanel } from './ui/ExperimentPanel.tsx';

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

function subscribeScheme(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
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
  const canvas3dRef = useCallback((el: HTMLCanvasElement | null) => ctrl.attach3D(el), [ctrl]);
  const presets = useMemo(() => Object.entries(PRESETS), []);

  const loaded = st.status === 'ready' || st.status === 'playing';
  const playing = st.status === 'playing';
  const meanKmh = st.metrics ? (st.metrics.meanSpeedMps * 3.6).toFixed(1) : '—';
  const network = st.network;
  const [tab, setTab] = useState<'live' | 'experiments'>('live');
  const darkScheme = useSyncExternalStore(subscribeScheme, () => !window.matchMedia('(prefers-color-scheme: light)').matches);

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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <aside className="order-3 shrink-0 border-border bg-surface md:order-1 md:w-80 md:overflow-y-auto md:border-r">
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
                <ScenarioForm ctrl={ctrl} scenario={st.scenario} network={st.network} />
              </div>
            ) : (
              <p className="text-sm text-muted">Loading scenario…</p>
            )}
          </Panel>
        </aside>

        <main className="relative order-1 min-h-[55vh] flex-1 bg-ground md:order-2 md:min-h-0" aria-label="Simulation view">
          <canvas
            ref={canvasRef}
            data-testid="sim-canvas"
            className={`absolute inset-0 h-full w-full touch-none ${st.view === '3d' ? 'invisible' : ''}`}
            aria-label="Road network and vehicles. Drag to pan, scroll or pinch to zoom, double-click to fit. Hover or tap a vehicle or road to inspect it."
          />
          {st.view === '3d' && (
            <canvas
              ref={canvas3dRef}
              data-testid="sim-canvas-3d"
              className="absolute inset-0 h-full w-full touch-none"
              aria-label="3D view of the road network and vehicles. Drag to orbit, right-drag or two fingers to pan, scroll or pinch to zoom."
            />
          )}
          {st.view === '3d' && st.view3dStatus === 'loading' && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted" role="status">
              Loading 3D view…
            </p>
          )}
          {!loaded && st.status !== 'error' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
              <p className="flex items-center gap-2 text-sm text-muted" role="status">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                Starting simulation…
              </p>
            </div>
          )}
          {loaded && (
            <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start gap-2">
              <div className="pointer-events-auto">
                <Segmented
                  label="Colour by"
                  value={st.colourMode}
                  options={[
                    { value: 'class', label: 'Class' },
                    { value: 'speed', label: 'Speed' },
                  ]}
                  onChange={(m) => ctrl.setColourMode(m)}
                />
              </div>
              <div className="pointer-events-auto">
                <Segmented
                  label="View"
                  value={st.view}
                  options={[
                    { value: '2d', label: '2D' },
                    { value: '3d', label: '3D' },
                  ]}
                  onChange={(v) => ctrl.setView(v)}
                />
              </div>
              {st.view3dError && (
                <p role="status" className="pointer-events-auto rounded-md border border-danger/40 bg-surface/95 px-2 py-1 text-xs text-danger">
                  {st.view3dError}
                </p>
              )}
            </div>
          )}
          {loaded && (
            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-6.5rem)]">
              <Legend mode={st.colourMode} classes={st.classes.classes} dark={darkScheme} />
            </div>
          )}
          {loaded && st.view === '2d' && st.inspect && (
            <div className="pointer-events-none absolute top-14 right-3">
              <InspectCard info={st.inspect} onClose={() => ctrl.clearInspect()} />
            </div>
          )}
          {loaded && st.view === '2d' && (
            <button
              type="button"
              onClick={() => ctrl.fitView()}
              className="absolute right-3 bottom-3 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-muted backdrop-blur hover:text-text"
            >
              Fit view
            </button>
          )}
        </main>

        <aside className="order-2 shrink-0 border-border bg-surface md:order-3 md:w-80 md:overflow-y-auto md:border-l">
          <div role="tablist" aria-label="Results" className="flex border-b border-border px-2 pt-2">
            {(['live', 'experiments'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}
              >
                {t === 'live' ? 'Live' : 'Experiments'}
              </button>
            ))}
          </div>
          {tab === 'experiments' && (
            <Panel title="Experiments">
              {st.scenario ? (
                <ExperimentPanel scenario={st.scenario} network={st.network} />
              ) : (
                <p className="text-sm text-muted">Choose a scenario first.</p>
              )}
            </Panel>
          )}
          {tab === 'live' && <>
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
            {st.metrics?.gridlock && (
              <div role="status" data-testid="gridlock" className="mt-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
                <p className="font-medium">
                  Gridlock: {st.metrics.gridlock.junctions.length} junction{st.metrics.gridlock.junctions.length === 1 ? '' : 's'} locked
                </p>
                <p className="mt-0.5 text-muted">
                  No vehicle in a junction's area has moved for 5 minutes (since t = {Math.round(st.metrics.gridlock.sinceS)} s). Vehicles are
                  never removed to clear it.
                </p>
              </div>
            )}
            {st.metrics && (
              <p className="mt-2 text-xs text-muted" data-testid="guard-rate" title="How often the kinematic collision guard had to cap a vehicle's movement (ADR-015). It is a rare safety net; see VALIDATION.md.">
                Collision guard: {st.metrics.guardActivations} activations
                {st.metrics.vehicleKm > 0 &&
                  ` (${((1000 * st.metrics.guardActivations) / st.metrics.vehicleKm).toFixed(1)} per 1,000 vehicle-km)`}
              </p>
            )}
          </Panel>
          <Panel title="Over time (1-minute windows)">
            <LiveCharts rows={st.series} />
          </Panel>
          <Panel title="Run data">
            <RunData ctrl={ctrl} enabled={st.status === 'ready' && st.t > 0} />
          </Panel>
          </>}
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
