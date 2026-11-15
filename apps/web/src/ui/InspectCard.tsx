import type { InspectInfo } from '../state/controller.ts';

/** Info card for the vehicle or road under the pointer / last tapped (§6.3 item 5). */
export function InspectCard({ info, onClose }: { info: InspectInfo; onClose: () => void }) {
  const rows: [string, string][] =
    info.kind === 'vehicle'
      ? [
          ['Speed', `${info.speedKmh.toFixed(1)} km/h`],
          ['On', info.segment],
          ['Size', `${info.lengthM.toFixed(1)} × ${info.widthM.toFixed(2)} m`],
        ]
      : [
          ['Width', `${info.widthM.toFixed(2)} m${info.lanes ? ` · ${info.lanes} lane${info.lanes === 1 ? '' : 's'}` : ''}`],
          ['Speed limit', `${info.speedLimitKmh.toFixed(0)} km/h`],
          ['Vehicles now', String(info.onNow)],
          ['Their mean speed', info.onNow ? `${info.meanSpeedKmh.toFixed(1)} km/h` : '—'],
        ];
  return (
    <div
      data-testid="inspect-card"
      role="dialog"
      aria-label={info.kind === 'vehicle' ? `Vehicle: ${info.classLabel}` : `Road ${info.id}`}
      className="pointer-events-auto w-60 rounded-md border border-border bg-surface/95 p-2.5 text-xs shadow-md backdrop-blur"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <p className="min-w-0 font-medium text-text">
          {info.kind === 'vehicle' ? info.classLabel : info.segKind === 'link' ? 'Road link' : 'Junction movement'}
          {info.kind === 'road' && <span className="block truncate font-mono text-[11px] font-normal text-muted">{info.id}</span>}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded p-1 text-muted hover:text-text">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="truncate text-right font-mono text-text">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
