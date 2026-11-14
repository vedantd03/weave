import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SeriesRow } from '@weave/engine';

interface ChartSpec {
  id: string;
  title: string;
  unit: string;
  value: (r: SeriesRow) => number;
  colorVar: string;
}

const CHARTS: ChartSpec[] = [
  { id: 'chart-flow', title: 'Exit flow', unit: 'veh/h', value: (r) => r.exitFlowVph, colorVar: '--color-info' },
  { id: 'chart-speed', title: 'Mean speed', unit: 'km/h', value: (r) => r.meanSpeedMps * 3.6, colorVar: '--color-ok' },
  { id: 'chart-density', title: 'Density', unit: 'veh/km', value: (r) => r.densityPerKm, colorVar: '--color-accent' },
  { id: 'chart-queue', title: 'Entry queue', unit: 'veh', value: (r) => r.entryQueue, colorVar: '--color-danger' },
];

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function Chart({ spec, rows }: { spec: ChartSpec; rows: SeriesRow[] }) {
  const host = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);

  const data = (): uPlot.AlignedData => [rows.map((r) => r.t1 / 60), rows.map(spec.value)];

  useEffect(() => {
    const el = host.current;
    if (!el || rows.length === 0) return;
    if (!plot.current) {
      const muted = cssVar('--color-muted', '#8b9bb0');
      const grid = cssVar('--color-border', '#233041');
      const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: '11px ui-sans-serif, system-ui' };
      plot.current = new uPlot(
        {
          width: Math.max(el.clientWidth, 120),
          height: 110,
          legend: { show: false },
          cursor: { drag: { x: false, y: false } },
          scales: { x: { time: false }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.1 : 1] } },
          axes: [
            { ...axis, size: 28, values: (_u, v) => v.map((x) => `${x}′`) },
            {
              ...axis,
              size: 52,
              values: (_u, v) => v.map((x) => (Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(x % 1000 === 0 ? 0 : 1)}k` : `${x}`)),
            },
          ],
          series: [{}, { stroke: cssVar(spec.colorVar, '#38bdf8'), width: 2, points: { show: rows.length < 3 } }],
        },
        data(),
        el,
      );
      const ro = new ResizeObserver(() => plot.current?.setSize({ width: Math.max(el.clientWidth, 120), height: 110 }));
      ro.observe(el);
      return () => {
        ro.disconnect();
        plot.current?.destroy();
        plot.current = null;
      };
    }
    plot.current.setData(data());
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length === 0]);

  useEffect(() => {
    if (plot.current && rows.length) plot.current.setData(data());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const last = rows.length ? spec.value(rows[rows.length - 1]!) : null;
  return (
    <figure className="rounded-lg border border-border bg-surface-2 p-2.5">
      <figcaption className="mb-1 flex items-baseline justify-between text-[11px] text-muted">
        <span className="uppercase tracking-wider">{spec.title}</span>
        <span className="font-mono text-xs text-text">
          {last === null ? '—' : last.toFixed(last >= 100 ? 0 : 1)} <span className="text-muted">{spec.unit}</span>
        </span>
      </figcaption>
      <div ref={host} data-testid={spec.id} className="min-h-[110px] w-full">
        {rows.length === 0 && <p className="pt-9 text-center text-xs text-muted">First point after 1 simulated minute</p>}
      </div>
    </figure>
  );
}

export function LiveCharts({ rows }: { rows: SeriesRow[] }) {
  return (
    <div className="space-y-2">
      {CHARTS.map((c) => (
        <Chart key={c.id} spec={c} rows={rows} />
      ))}
    </div>
  );
}
