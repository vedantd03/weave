import { useSyncExternalStore } from 'react';
import type { MetricId, ScenarioInput } from '@weave/engine';
import { DEFAULT_METRICS, loadHistory, type ExperimentResult, type ExpType, type Progress } from './experiment.ts';
import type { ExperimentFileInput } from '@weave/engine';

/** Experiments view state; lives outside React so it survives switching tabs (§7.4). */
export interface ExpState {
  type: ExpType;
  reps: number;
  durationMin: number | null; // null: use the scenario's
  warmupMin: number | null;
  metrics: MetricId[];
  compare: { name: string; scenario: ScenarioInput }[];
  sweep: { param: string; from: number; to: number; steps: number; choices: string[] };
  estimate: { perRunMs: number; workers: number; key: string } | null;
  running: boolean;
  progress: Progress | null;
  startedAt: number;
  result: ExperimentResult | null;
  error: string | null;
  history: ExperimentFileInput[];
  /** createdAt of history entries ticked for side-by-side comparison. */
  picked: string[];
  importStatus: string | null;
}

let state: ExpState = {
  type: 'replicate',
  reps: 10,
  durationMin: null,
  warmupMin: null,
  metrics: DEFAULT_METRICS,
  compare: [],
  sweep: { param: '', from: 0, to: 0, steps: 3, choices: [] },
  estimate: null,
  running: false,
  progress: null,
  startedAt: 0,
  result: null,
  error: null,
  history: [],
  picked: [],
  importStatus: null,
};
let historyLoaded = false;
const listeners = new Set<() => void>();

export function getExp(): ExpState {
  if (!historyLoaded) {
    historyLoaded = true;
    state = { ...state, history: loadHistory() };
  }
  return state;
}

export function setExp(patch: Partial<ExpState> | ((s: ExpState) => Partial<ExpState>)): void {
  const p = typeof patch === 'function' ? patch(getExp()) : patch;
  state = { ...getExp(), ...p };
  for (const l of listeners) l();
}

export function useExp(): ExpState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getExp,
  );
}
