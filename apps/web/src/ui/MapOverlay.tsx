import type { VehicleClassId } from '@weave/engine';
import { SPEED_GRADIENT, classCss, type ColourMode } from '../render/palette.ts';

/** Segmented control: a radio group of buttons (accessible names = the option labels). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-surface/90 p-0.5 text-xs shadow-sm backdrop-blur">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 font-medium transition-colors disabled:opacity-40 ${
            value === o.value ? 'bg-accent text-accent-ink' : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Legend for the active colour mode (§6.3 item 2). */
export function Legend({ mode, classes, dark }: { mode: ColourMode; classes: { id: VehicleClassId; label: string }[]; dark: boolean }) {
  return (
    <div data-testid="legend" className="rounded-md border border-border bg-surface/90 px-2.5 py-2 text-[11px] text-muted shadow-sm backdrop-blur">
      {mode === 'class' ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
          {classes.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5">
              <span className="h-2 w-3.5 shrink-0 rounded-sm" style={{ background: classCss(c.id, dark) }} />
              {c.label}
            </li>
          ))}
        </ul>
      ) : (
        <div className="w-44">
          <div className="h-2 rounded-sm" style={{ background: SPEED_GRADIENT }} />
          <div className="mt-1 flex justify-between">
            <span>Stopped</span>
            <span>Free flow</span>
          </div>
          <p className="mt-0.5 text-[10px]">speed ÷ free-flow speed</p>
        </div>
      )}
    </div>
  );
}
