import { useEffect, useRef, useState } from 'react';
import { SimClient } from './worker/client.ts';

type WorkerState = { kind: 'starting' } | { kind: 'ready'; pingMs: number } | { kind: 'error'; message: string };

function useSimClient() {
  const clientRef = useRef<SimClient | null>(null);
  const [state, setState] = useState<WorkerState>({ kind: 'starting' });

  useEffect(() => {
    const client = new SimClient();
    clientRef.current = client;
    const off = client.on((msg) => {
      if (msg.type === 'error') setState({ kind: 'error', message: msg.message });
    });
    client
      .ping()
      .then((ms) => setState({ kind: 'ready', pingMs: ms }))
      .catch((e: unknown) => setState({ kind: 'error', message: String(e) }));
    return () => {
      off();
      client.terminate();
      clientRef.current = null;
    };
  }, []);

  return { client: clientRef, state };
}

function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`border-b border-border px-4 py-4 ${className}`}>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-9 items-center justify-between rounded-md border border-border bg-surface-2 px-3 text-sm text-muted">
      <span>{label}</span>
      <span className="h-1.5 w-10 rounded-full bg-border" />
    </div>
  );
}

function StatTile({ label, unit }: { label: string; unit: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl text-text">
        —<span className="ml-1 text-xs text-muted">{unit}</span>
      </div>
    </div>
  );
}

export default function App() {
  const { state } = useSimClient();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight">Weave</span>
          <span className="hidden text-sm text-muted sm:inline">mixed-traffic simulator</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled
            className="h-9 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
          >
            Run
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="order-2 shrink-0 overflow-y-auto border-border bg-surface md:order-1 md:w-80 md:border-r">
          <Panel title="Network">
            <div className="space-y-2">
              <Placeholder label="Junction, corridor, merge or Silk Board" />
            </div>
          </Panel>
          <Panel title="Demand">
            <div className="space-y-2">
              <Placeholder label="Origin–destination table" />
              <Placeholder label="Vehicle mix" />
            </div>
          </Panel>
          <Panel title="Model">
            <div className="space-y-2">
              <Placeholder label="Strip or lane mode" />
              <Placeholder label="Seeds and duration" />
            </div>
          </Panel>
        </aside>

        <main className="relative order-1 min-h-[50vh] flex-1 bg-ground md:order-2 md:min-h-0" aria-label="Simulation view">
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-sm">
              <p className="text-base font-medium text-text">No scenario loaded</p>
              <p className="mt-1 text-sm text-muted">
                Set up a network and demand, then run the simulation. Vehicles are simulated in your browser.
              </p>
            </div>
          </div>
        </main>

        <aside className="order-3 shrink-0 overflow-y-auto border-border bg-surface md:w-72 md:border-l">
          <Panel title="Live metrics">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Vehicles" unit="" />
              <StatTile label="Mean speed" unit="km/h" />
              <StatTile label="Throughput" unit="veh/h" />
              <StatTile label="Entry queue" unit="veh" />
            </div>
          </Panel>
        </aside>
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-xs text-muted">
        <span data-testid="worker-status" className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              state.kind === 'ready' ? 'bg-ok' : state.kind === 'error' ? 'bg-danger' : 'bg-muted'
            }`}
          />
          {state.kind === 'ready' && <>Engine worker ready · {state.pingMs.toFixed(1)} ms</>}
          {state.kind === 'starting' && <>Starting engine worker…</>}
          {state.kind === 'error' && <>Engine worker error: {state.message}</>}
        </span>
      </footer>
    </div>
  );
}
