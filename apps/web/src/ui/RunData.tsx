import { useState } from 'react';
import { SERIES_FIELDS, TRIP_FIELDS, type RunExport } from '@weave/engine';
import type { SimController } from '../state/controller.ts';

/** Export run JSON and trips/series CSV (MODEL.md §6.3 item 6). */

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: readonly Record<string, unknown>[], fields: readonly string[]): string {
  return [fields.join(','), ...rows.map((r) => fields.map((f) => cell(r[f])).join(','))].join('\n') + '\n';
}

export function RunData({ ctrl, enabled }: { ctrl: SimController; enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: 'json' | 'trips' | 'series') => {
    setBusy(true);
    setError(null);
    try {
      const { run: r, filename } = await ctrl.exportRun();
      if (what === 'json') download(`${filename}.json`, JSON.stringify(r, null, 1), 'application/json');
      else if (what === 'trips') download(`${filename}-trips.csv`, toCsv(r.trips, TRIP_FIELDS), 'text/csv');
      else download(`${filename}-series.csv`, toCsv(r.series as RunExport['series'], r.series.length ? Object.keys(r.series[0]!) : SERIES_FIELDS), 'text/csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const off = !enabled || busy;
  const btn = 'h-8 rounded-md border border-border bg-surface-2 px-2 text-sm text-text hover:bg-border disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="space-y-2">
      <button type="button" disabled={off} onClick={() => void run('json')} className="h-9 w-full rounded-md bg-accent text-sm font-medium text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
        Export run
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={off} onClick={() => void run('trips')} className={btn}>
          Trips CSV
        </button>
        <button type="button" disabled={off} onClick={() => void run('series')} className={btn}>
          Series CSV
        </button>
      </div>
      <p className="text-xs text-muted">
        {enabled
          ? 'One JSON file with the scenario, seed, final state hash, metrics, 1-minute series, per-link statistics, trip records and diagnostics. Replay it with the Node CLI.'
          : 'Pause a run with some simulated time to export it.'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
