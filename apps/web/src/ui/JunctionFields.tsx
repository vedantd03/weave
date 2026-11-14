import { cycleLength, type JunctionParams, type MergeParams, type OdEntry, type SignalPlan } from '@weave/engine';

/** Form pieces for M3: junction/flyover and merge generators, OD table, signal plan. */

const field =
  'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text tabular-nums focus:border-accent';

export function Num(props: { id: string; label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <div className="min-w-0">
      <label htmlFor={props.id} className="mb-1 block truncate text-xs text-muted">
        {props.label}
      </label>
      <input
        id={props.id}
        type="number"
        inputMode="decimal"
        step="any"
        min={props.min}
        className={field}
        value={Number.isFinite(props.value) ? props.value : ''}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) props.onChange(v);
        }}
      />
    </div>
  );
}

function Sel(props: { id: string; label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="min-w-0">
      <label htmlFor={props.id} className="mb-1 block truncate text-xs text-muted">
        {props.label}
      </label>
      <select id={props.id} className={field} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

const ARM = (angleDeg: number) => ({ angleDeg, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 });

/** Default demand for an N-arm junction: 450 veh/h to the most opposite arm, 150 to the others. */
export function junctionOd(n: number): OdEntry[] {
  const out: OdEntry[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const opposite = (i + Math.round(n / 2)) % n === k;
      out.push({ origin: `arm${i}_in`, destination: `arm${k}_out`, rateVph: opposite ? 450 : 150 });
    }
  }
  return out;
}

export function JunctionFields({
  p,
  set,
  onArmsChange,
}: {
  p: JunctionParams;
  set: (patch: Partial<JunctionParams>) => void;
  onArmsChange: (n: number) => void;
}) {
  const n = p.arms.length;
  const fly = p.flyover;
  const armOpts: [string, string][] = p.arms.map((_, k) => [String(k), `Arm ${k + 1}`]);
  const setArm = (k: number, patch: Partial<JunctionParams['arms'][number]>) =>
    set({ arms: p.arms.map((a, i) => (i === k ? { ...a, ...patch } : a)) });
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-medium text-text">Junction</legend>
      <div className="grid grid-cols-2 gap-2">
        <Num
          id="f-arms"
          label="Arms"
          value={n}
          min={3}
          onChange={(v) => {
            const k = Math.min(6, Math.max(3, Math.round(v)));
            if (k !== n) onArmsChange(k);
          }}
        />
        <Sel
          id="f-control"
          label="Control"
          value={p.control}
          options={[
            ['signal', 'Signals'],
            ['priority', 'Priority (yield)'],
          ]}
          onChange={(v) =>
            set(v === 'priority' ? { control: 'priority', majorArms: p.majorArms ?? [0, Math.min(2, n - 1)] } : { control: 'signal' })
          }
        />
      </div>
      <div className="space-y-1.5">
        {p.arms.map((a, k) => (
          <div key={k} className="grid grid-cols-3 gap-2">
            <Num id={`f-arm${k}-angle`} label={`Arm ${k + 1} angle (°)`} value={a.angleDeg} onChange={(v) => setArm(k, { angleDeg: ((v % 360) + 360) % 360 })} />
            <Num id={`f-arm${k}-in`} label={`Arm ${k + 1} in width (m)`} value={a.inWidthM} onChange={(v) => setArm(k, { inWidthM: v })} />
            <Num id={`f-arm${k}-out`} label={`Arm ${k + 1} out width (m)`} value={a.outWidthM} onChange={(v) => setArm(k, { outWidthM: v })} />
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 pt-1 text-sm text-text">
        <input
          type="checkbox"
          aria-label="Flyover"
          className="h-4 w-4 accent-[var(--color-accent)]"
          checked={Boolean(fly?.enabled)}
          onChange={(e) =>
            set({
              flyover: {
                enabled: e.target.checked,
                armA: fly?.armA ?? 0,
                armB: fly?.armB ?? Math.min(2, n - 1),
                deckWidthM: fly?.deckWidthM ?? 7,
                rampWidthM: fly?.rampWidthM ?? 3.5,
                landingWidthM: fly?.landingWidthM ?? 3.5,
                rampLengthM: fly?.rampLengthM ?? 150,
                heightM: fly?.heightM ?? 6.5,
              },
            })
          }
        />
        Flyover
      </label>
      {fly?.enabled && (
        <div className="grid grid-cols-2 gap-2">
          <Sel id="f-fly-a" label="Flyover from arm" value={String(fly.armA)} options={armOpts} onChange={(v) => set({ flyover: { ...fly, armA: Number(v) } })} />
          <Sel id="f-fly-b" label="Flyover to arm" value={String(fly.armB)} options={armOpts} onChange={(v) => set({ flyover: { ...fly, armB: Number(v) } })} />
          <Num id="f-deck" label="Deck width (m)" value={fly.deckWidthM} onChange={(v) => set({ flyover: { ...fly, deckWidthM: v } })} />
          <Num id="f-ramp" label="Ramp width (m)" value={fly.rampWidthM} onChange={(v) => set({ flyover: { ...fly, rampWidthM: v } })} />
          <Num id="f-landing" label="Landing width (m)" value={fly.landingWidthM} onChange={(v) => set({ flyover: { ...fly, landingWidthM: v } })} />
          <Num id="f-ramplen" label="Ramp length (m)" value={fly.rampLengthM} onChange={(v) => set({ flyover: { ...fly, rampLengthM: v } })} />
        </div>
      )}
    </fieldset>
  );
}

export function defaultArms(n: number) {
  return Array.from({ length: n }, (_, k) => ARM((360 * k) / n));
}

export function MergeFields({ p, set }: { p: MergeParams; set: (patch: Partial<MergeParams>) => void }) {
  return (
    <fieldset className="grid grid-cols-2 gap-2">
      <legend className="mb-1 text-xs font-medium text-text">On-ramp merge</legend>
      <Num id="f-mainw" label="Main width (m)" value={p.mainWidthM} onChange={(v) => set({ mainWidthM: v })} />
      <Num id="f-mainl" label="Main lanes" value={p.mainLanes} onChange={(v) => set({ mainLanes: Math.round(v) })} />
      <Num id="f-rampw" label="Ramp width (m)" value={p.rampWidthM} onChange={(v) => set({ rampWidthM: v })} />
      <Num id="f-taper" label="Acceleration lane (m)" value={p.taperM} onChange={(v) => set({ taperM: v })} />
    </fieldset>
  );
}

export function OdEditor({ od, onChange }: { od: OdEntry[]; onChange: (od: OdEntry[]) => void }) {
  const total = od.reduce((a, r) => a + r.rateVph, 0);
  return (
    <details open={od.length <= 20} className="rounded-md border border-border">
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted">
        Origin–destination demand · {od.length} pairs · {Math.round(total)} veh/h
      </summary>
      <div className="max-h-64 space-y-1 overflow-y-auto px-2 pb-2">
        {od.map((r, i) => {
          const id = `f-od-${i}`;
          const label = `${r.origin} → ${r.destination} (veh/h)`;
          return (
            <div key={`${r.origin}>${r.destination}`} className="grid grid-cols-[1fr_5.5rem] items-center gap-2">
              <label htmlFor={id} className="truncate text-xs text-muted" title={label}>
                {label}
              </label>
              <input
                id={id}
                type="number"
                step="any"
                min={0}
                className={field}
                value={r.rateVph}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value !== '' && Number.isFinite(v)) onChange(od.map((x, j) => (j === i ? { ...x, rateVph: v } : x)));
                }}
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function SignalEditor({ plan, onChange }: { plan: SignalPlan; onChange: (p: SignalPlan) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 flex w-full items-baseline justify-between text-xs font-medium text-text">
        <span>Signal plan</span>
        <span className="font-normal text-muted">
          cycle <span data-testid="cycle-length">{cycleLength(plan)}</span> s
        </span>
      </legend>
      <div className="grid grid-cols-3 gap-2">
        {plan.phases.map((ph, i) => (
          <Num
            key={i}
            id={`f-phase-${i}`}
            label={`Phase ${i + 1} green (s)`}
            value={ph.greenS}
            onChange={(v) => onChange({ ...plan, phases: plan.phases.map((x, j) => (j === i ? { ...x, greenS: Math.max(1, v) } : x)) })}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Num id="f-amber" label="Amber (s)" value={plan.amberS} onChange={(v) => onChange({ ...plan, amberS: Math.max(0, v) })} />
        <Num id="f-allred" label="All-red (s)" value={plan.allRedS} onChange={(v) => onChange({ ...plan, allRedS: Math.max(0, v) })} />
        <Num id="f-offset" label="Offset (s)" value={plan.offsetS} onChange={(v) => onChange({ ...plan, offsetS: Math.max(0, v) })} />
      </div>
    </fieldset>
  );
}
