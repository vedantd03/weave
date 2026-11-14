import { useEffect, useMemo, useState } from 'react';
import { Scenario, type ScenarioInput } from '@weave/engine';
import type { SimController } from '../state/controller.ts';

/**
 * Scenario editor: generator parameters (with an instant network preview), demand, lateral
 * model and seed. "Apply" rebuilds the scenario in the worker and leaves it paused.
 */

type Draft = ScenarioInput;

const field =
  'h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text tabular-nums focus:border-accent';

function NumberField(props: {
  id: string;
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  return (
    <div className="min-w-0">
      <label htmlFor={props.id} className="mb-1 block text-xs text-muted">
        {props.label}
      </label>
      <input
        id={props.id}
        type="number"
        inputMode="decimal"
        className={field}
        value={text}
        step="any"
        min={props.min}
        max={props.max}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) props.onChange(v);
        }}
      />
    </div>
  );
}

function SelectField<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={props.id} className="mb-1 block text-xs text-muted">
        {props.label}
      </label>
      <select id={props.id} className={field} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

type Params = Extract<ScenarioInput['network'], { kind: 'generator' }>['params'];

export function ScenarioForm({ ctrl, scenario }: { ctrl: SimController; scenario: ScenarioInput }) {
  const [draft, setDraft] = useState<Draft>(scenario);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    setDraft(scenario);
    setError(null);
  }, [scenario]);

  const params: Params | null = draft.network.kind === 'generator' ? draft.network.params : null;

  const setParams = (patch: Record<string, unknown>) => {
    if (!params) return;
    const next = { ...params, ...patch } as Params;
    setDraft({ ...draft, network: { kind: 'generator', params: next } });
    setError(ctrl.preview(next));
  };

  const od = draft.od ?? [];
  const demand = useMemo(() => od.reduce((a, r) => a + r.rateVph, 0), [od]);
  const setDemand = (total: number) => {
    if (od.length === 0) return;
    const scale = demand > 0 ? total / demand : 0;
    setDraft({
      ...draft,
      od: od.map((r, i) => ({ ...r, rateVph: demand > 0 ? r.rateVph * scale : i === 0 ? total : 0 })),
    });
  };

  const apply = () => {
    setError(null);
    // Validate the whole draft against the contract and show every problem (no silent no-op).
    const parsed = Scenario.safeParse(draft);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) => {
          const path = i.path.filter((p) => typeof p !== 'number' || p > 0).join(' › ');
          return path ? `${path}: ${i.message}` : i.message;
        }),
      );
      return;
    }
    setIssues([]);
    ctrl.loadScenario(draft).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {params?.generator === 'corridor' && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-text">Road</legend>
          <div className="grid grid-cols-3 gap-2">
            <NumberField id="f-length" label="Length (m)" value={params.lengthM} step={50} onChange={(v) => setParams({ lengthM: v })} />
            <NumberField id="f-width" label="Width (m)" value={params.widthM} step={0.5} onChange={(v) => setParams({ widthM: v })} />
            <NumberField id="f-lanes" label="Lanes" value={params.lanes} min={1} max={6} onChange={(v) => setParams({ lanes: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
            <SelectField
              id="f-change"
              label="Change"
              value={params.change.kind}
              options={[
                { value: 'none', label: 'None' },
                { value: 'width', label: 'Width' },
                { value: 'laneDrop', label: 'Lane drop' },
              ]}
              onChange={(kind) => {
                const atM = 'atM' in params.change ? params.change.atM : Math.round(params.lengthM * 0.6);
                const change =
                  kind === 'none'
                    ? { kind }
                    : kind === 'width'
                      ? { kind, atM, toWidthM: Math.max(3, params.widthM - 3.5), toLanes: Math.max(1, params.lanes - 1), taperM: 30 }
                      : { kind, atM, dropLanes: 1, taperM: 50 };
                setParams({ change });
              }}
            />
            </div>
            {params.change.kind !== 'none' && (
              <NumberField
                id="f-at"
                label="At (m)"
                value={params.change.atM}
                step={50}
                onChange={(v) => setParams({ change: { ...params.change, atM: v } })}
              />
            )}
            {params.change.kind === 'laneDrop' && (
              <NumberField
                id="f-drop"
                label="Drop lanes"
                value={params.change.dropLanes}
                min={1}
                onChange={(v) => setParams({ change: { ...params.change, dropLanes: v } })}
              />
            )}
            {params.change.kind === 'width' && (
              <NumberField
                id="f-towidth"
                label="To width (m)"
                value={params.change.toWidthM}
                step={0.5}
                onChange={(v) => setParams({ change: { ...params.change, toWidthM: v } })}
              />
            )}
          </div>
        </fieldset>
      )}

      {params?.generator === 'ring' && (
        <fieldset className="grid grid-cols-3 gap-2">
          <legend className="mb-1 text-xs font-medium text-text">Road</legend>
          <NumberField id="f-circ" label="Length (m)" value={params.circumferenceM} step={100} onChange={(v) => setParams({ circumferenceM: v })} />
          <NumberField id="f-width" label="Width (m)" value={params.widthM} step={0.5} onChange={(v) => setParams({ widthM: v })} />
          <NumberField id="f-lanes" label="Lanes" value={params.lanes ?? 1} min={1} max={6} onChange={(v) => setParams({ lanes: v })} />
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
        <SelectField
          id="f-mode"
          label="Lateral model"
          value={draft.mode ?? 'strip'}
          options={[
            { value: 'strip', label: 'Strips (mixed traffic)' },
            { value: 'lane', label: 'Lanes (theory check)' },
          ]}
          onChange={(mode) => setDraft({ ...draft, mode })}
        />
        {draft.mode === 'lane' && (
          <p className="mt-1 text-xs text-muted">
            Lane mode reuses the strip-calibrated driver parameters, so its capacity is not calibrated. Use it to check
            the model against classic lane-based theory.
          </p>
        )}
        </div>
        {od.length > 0 && (
          <NumberField id="f-demand" label="Demand (veh/h)" value={Math.round(demand)} step={100} min={0} onChange={setDemand} />
        )}
        <NumberField id="f-seed" label="Seed" value={draft.seed} min={0} onChange={(v) => setDraft({ ...draft, seed: Math.max(0, Math.floor(v)) })} />
      </div>

      {issues.length > 0 && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          <p className="font-medium">Fix these before applying:</p>
          <ul className="mt-1 list-disc pl-4">
            {issues.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <button type="submit" className="h-9 w-full rounded-md bg-accent text-sm font-semibold text-accent-ink hover:brightness-110">
        Apply
      </button>
    </form>
  );
}
