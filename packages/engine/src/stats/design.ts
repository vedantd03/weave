import type { Network, SignalPlan } from '../schema/network.ts';
import type { ScenarioInput } from '../schema/scenario.ts';
import type { ExperimentDesign } from '../schema/experiment.ts';
import { generateNetwork } from '../scenarios/generators/index.ts';
import { pairedCI, type CI } from './ci.ts';
import { tQuantile } from './tdist.ts';
import { METRICS, type MetricId, type ReplicateResult } from './experiment.ts';

/** Experiment design helpers (docs/MODEL.md §7.3): pure functions, no simulation. */

/* ---------------- run counts ---------------- */

export function runCount(d: Pick<ExperimentDesign, 'type' | 'reps'> & { scenarios?: unknown[]; values?: unknown[] }): number {
  if (!(Number.isInteger(d.reps) && d.reps >= 1)) throw new Error('reps must be a positive integer');
  if (d.type === 'replicate') return d.reps;
  if (d.type === 'compare') {
    const n = d.scenarios?.length ?? 0;
    if (n < 2) throw new Error('Compare needs at least 2 scenarios');
    return d.reps * n;
  }
  const n = d.values?.length ?? 0;
  if (n < 1 || n > 10) throw new Error('Sweep needs 1 to 10 values');
  return d.reps * n;
}

/* ---------------- pairing and Welch ---------------- */

export function pairable(a: ScenarioInput, b: ScenarioInput): { paired: true } | { paired: false; reason: string } {
  const set = (xs: string[]) => [...new Set(xs)].sort().join('|');
  const odA = a.od ?? [];
  const odB = b.od ?? [];
  if (set(odA.map((r) => r.origin)) !== set(odB.map((r) => r.origin))) return { paired: false, reason: 'different origin zones' };
  if (set(odA.map((r) => r.destination)) !== set(odB.map((r) => r.destination))) return { paired: false, reason: 'different destination zones' };
  if (set(odA.map((r) => `${r.origin}>${r.destination}`)) !== set(odB.map((r) => `${r.origin}>${r.destination}`))) {
    return { paired: false, reason: 'different OD pairs' };
  }
  return { paired: true };
}

export type WelchCI = CI & { df: number };

/** CI of mean(b) − mean(a) for independent samples (Welch–Satterthwaite). */
export function welchCI(a: readonly number[], b: readonly number[], level = 0.95): WelchCI {
  const stats = (x: readonly number[]) => {
    const n = x.length;
    const m = x.reduce((s, v) => s + v, 0) / n;
    const v = n > 1 ? x.reduce((s, y) => s + (y - m) * (y - m), 0) / (n - 1) : NaN;
    return { n, m, v };
  };
  const A = stats(a);
  const B = stats(b);
  const mean = B.m - A.m;
  const qa = A.v / A.n;
  const qb = B.v / B.n;
  const se2 = qa + qb;
  const se = Math.sqrt(se2);
  if (!(A.n > 1 && B.n > 1) || !Number.isFinite(se2)) {
    return { mean, half: Infinity, lo: -Infinity, hi: Infinity, n: Math.min(A.n, B.n), sd: NaN, df: NaN };
  }
  if (se === 0) return { mean, half: 0, lo: mean, hi: mean, n: Math.min(A.n, B.n), sd: 0, df: A.n + B.n - 2 };
  const df = (se2 * se2) / ((qa * qa) / (A.n - 1) + (qb * qb) / (B.n - 1));
  const half = tQuantile((1 + level) / 2, df) * se;
  return { mean, half, lo: mean - half, hi: mean + half, n: Math.min(A.n, B.n), sd: se, df };
}

/** Per-metric difference variant − base: paired-t when paired, otherwise Welch. */
export function compareRuns(base: ReplicateResult[], variant: ReplicateResult[], paired: boolean, level = 0.95): Record<MetricId, CI> {
  const out = {} as Record<MetricId, CI>;
  for (const m of METRICS) {
    const a = base.map((r) => r.metrics[m]);
    const b = variant.map((r) => r.metrics[m]);
    out[m] = paired ? pairedCI(a, b, level) : welchCI(a, b, level);
  }
  return out;
}

/* ---------------- sweep parameters ---------------- */

export interface SweepParam {
  id: string;
  label: string;
  unit: string;
  kind: 'number' | 'choice';
  current: number | string;
  /** Suggested range for numbers. */
  from?: number;
  to?: number;
  choices?: { value: string; label: string }[];
}

type Gen = Record<string, unknown> & { generator: string };
const genOf = (s: ScenarioInput): Gen | null => (s.network.kind === 'generator' ? (s.network.params as unknown as Gen) : null);
const netOf = (s: ScenarioInput, network?: Network): Network | null => {
  const g = genOf(s);
  if (g) {
    try {
      return generateNetwork(g as never);
    } catch {
      return null;
    }
  }
  return network ?? null;
};

/** The signal plans in force: the network's plans with the scenario's overrides by node. */
export function effectivePlans(s: ScenarioInput, network?: Network): SignalPlan[] {
  const net = netOf(s, network);
  const base = net?.signals ?? [];
  const over = new Map((s.signalOverrides ?? []).map((p) => [p.node, p]));
  const nodes = [...new Set([...base.map((p) => p.node), ...over.keys()])];
  return nodes.map((n) => {
    // Overrides are scenario input (defaults may be missing): fill them as the schema would.
    const o = over.get(n) as (Partial<SignalPlan> & { phases: Partial<SignalPlan['phases'][number]>[] }) | undefined;
    const b = base.find((p) => p.node === n);
    if (!o) return b as SignalPlan;
    const filled: Record<string, unknown> = { amberS: 3, allRedS: 2, offsetS: 0 };
    Object.assign(filled, o, { phases: o.phases.map((p) => Object.assign({ permissive: [] }, p)) });
    return filled as unknown as SignalPlan;
  });
}

/** "Arm k" when every protected movement of a phase comes from one generated arm, else "Phase k". */
function phaseLabel(plan: SignalPlan, k: number, net: Network | null): string {
  const mv = new Map((net?.movements ?? []).map((m) => [m.id, m]));
  const arms = new Set(
    (plan.phases[k]?.protected ?? []).map((id) => /^arm(\d+)_in/.exec(mv.get(id)?.fromLink ?? '')?.[1]).filter((x): x is string => x !== undefined),
  );
  const ok = arms.size === 1 && (plan.phases[k]?.protected ?? []).every((id) => /^arm\d+_in/.test(mv.get(id)?.fromLink ?? ''));
  return ok ? `Arm ${Number([...arms][0]) + 1}` : `Phase ${k + 1}`;
}

const DEFAULT_FLYOVER = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 150, heightM: 6.5 };

export function sweepParams(s: ScenarioInput, network?: Network): SweepParam[] {
  const out: SweepParam[] = [];
  const total = (s.od ?? []).reduce((a, r) => a + r.rateVph, 0);
  if ((s.od ?? []).length > 0) out.push({ id: 'demandScale', label: `Demand scale (× ${Math.round(total).toLocaleString('en-US')} veh/h)`, unit: '×', kind: 'number', current: 1, from: 0.6, to: 1.4 });
  const comp = (s.composition ?? {}) as Record<string, number>;
  const sum = Object.values(comp).reduce((a, b) => a + b, 0) || 1;
  out.push({ id: 'motorcycleShare', label: 'Motorcycle share', unit: '%', kind: 'number', current: Math.round((1000 * (comp.motorcycle ?? 0)) / sum) / 10, from: 30, to: 80 });
  const net = netOf(s, network);
  for (const plan of effectivePlans(s, network)) {
    plan.phases.forEach((ph, k) => {
      out.push({ id: `green:${plan.node}:${k}`, label: `${phaseLabel(plan, k, net)} green`, unit: 's', kind: 'number', current: ph.greenS, from: Math.max(5, ph.greenS - 15), to: ph.greenS + 15 });
    });
  }
  const g = genOf(s);
  if (g?.generator === 'junction') {
    (g.arms as { inWidthM: number }[]).forEach((a, k) => out.push({ id: `armWidth:${k}`, label: `Arm ${k + 1} width`, unit: 'm', kind: 'number', current: a.inWidthM, from: 3.5, to: 10.5 }));
    const fly = g.flyover as { enabled: boolean; rampLengthM: number } | undefined;
    if (fly?.enabled) out.push({ id: 'rampLength', label: 'Flyover ramp length', unit: 'm', kind: 'number', current: fly.rampLengthM, from: 80, to: 200 });
    out.push({ id: 'flyover', label: 'Flyover', unit: '', kind: 'choice', current: fly?.enabled ? 'on' : 'off', choices: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] });
  } else if (g?.generator === 'corridor' || g?.generator === 'ring') {
    out.push({ id: 'width', label: 'Road width', unit: 'm', kind: 'number', current: g.widthM as number, from: 3.5, to: 14 });
  } else if (g?.generator === 'merge') {
    out.push({ id: 'mainWidth', label: 'Main road width', unit: 'm', kind: 'number', current: g.mainWidthM as number, from: 3.5, to: 10.5 });
    out.push({ id: 'rampWidth', label: 'Ramp width', unit: 'm', kind: 'number', current: g.rampWidthM as number, from: 3, to: 7 });
    out.push({ id: 'accelLength', label: 'Acceleration lane length', unit: 'm', kind: 'number', current: g.taperM as number, from: 100, to: 400 });
  }
  out.push({ id: 'mode', label: 'Lateral model', unit: '', kind: 'choice', current: s.mode ?? 'strip', choices: [{ value: 'strip', label: 'Strips' }, { value: 'lane', label: 'Lanes' }] });
  return out;
}

export function sweepValues(from: number, to: number, steps: number): number[] {
  if (!(Number.isInteger(steps) && steps >= 1 && steps <= 10)) throw new Error('steps must be 1 to 10');
  if (steps === 1) return [from];
  return Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / (steps - 1));
}

const withGen = (s: ScenarioInput, patch: (g: Gen) => Gen): ScenarioInput => {
  const g = genOf(s);
  if (!g) throw new Error('parameter needs a generated network');
  return { ...s, network: { kind: 'generator', params: patch(g) as never } };
};

/** A copy of the scenario with only parameter `id` set to `value` (§7.3). */
export function applySweep(s: ScenarioInput, network: Network | undefined, id: string, value: number | string): ScenarioInput {
  const num = Number(value);
  if (id === 'demandScale') return { ...s, od: (s.od ?? []).map((r) => ({ ...r, rateVph: r.rateVph * num })) };
  if (id === 'motorcycleShare') {
    const comp = { ...((s.composition ?? {}) as Record<string, number>) };
    const others = Object.entries(comp).filter(([k]) => k !== 'motorcycle');
    const rest = others.reduce((a, [, v]) => a + v, 0);
    const share = Math.min(1, Math.max(0, num / 100));
    const next: Record<string, number> = { motorcycle: share };
    for (const [k, v] of others) next[k] = rest > 0 ? (v / rest) * (1 - share) : (1 - share) / others.length;
    return { ...s, composition: next as never };
  }
  if (id.startsWith('green:')) {
    const [, node, kStr] = id.split(':');
    const k = Number(kStr);
    const plan = effectivePlans(s, network).find((p) => p.node === node);
    if (!plan) throw new Error(`no signal plan at ${node}`);
    const edited = { ...plan, phases: plan.phases.map((p, i) => (i === k ? { ...p, greenS: num } : p)) };
    return { ...s, signalOverrides: [...(s.signalOverrides ?? []).filter((p) => p.node !== node), edited] };
  }
  if (id.startsWith('armWidth:')) {
    const k = Number(id.split(':')[1]);
    return withGen(s, (g) => ({ ...g, arms: (g.arms as Record<string, unknown>[]).map((a, i) => (i === k ? { ...a, inWidthM: num, outWidthM: num } : a)) }));
  }
  if (id === 'width') return withGen(s, (g) => ({ ...g, widthM: num }));
  if (id === 'mainWidth') return withGen(s, (g) => ({ ...g, mainWidthM: num }));
  if (id === 'rampWidth') return withGen(s, (g) => ({ ...g, rampWidthM: num }));
  if (id === 'accelLength') return withGen(s, (g) => ({ ...g, taperM: num }));
  if (id === 'rampLength') return withGen(s, (g) => ({ ...g, flyover: { ...(g.flyover as object), rampLengthM: num } }));
  if (id === 'flyover') return withGen(s, (g) => ({ ...g, flyover: { ...DEFAULT_FLYOVER, ...((g.flyover as object | undefined) ?? {}), enabled: value === 'on' } }));
  if (id === 'mode') return { ...s, mode: value === 'lane' ? 'lane' : 'strip' };
  throw new Error(`unknown sweep parameter ${id}`);
}

/* ---------------- plain-words differences ---------------- */

const fmt = (x: number, unit = '') => {
  const v = Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : `${Math.round(x * 100) / 100}`;
  return unit ? `${v}` : v;
};
const zone = (z: string) => {
  const m = /^arm(\d+)_(in|out)$/.exec(z);
  return m ? `Arm ${Number(m[1]) + 1}` : z;
};
const ARM_FIELDS: Record<string, [string, string]> = {
  angleDeg: ['angle', '°'],
  inWidthM: ['in-width', 'm'],
  outWidthM: ['out-width', 'm'],
  inLanes: ['in-lanes', ''],
  outLanes: ['out-lanes', ''],
  lengthM: ['length', 'm'],
};
const PARAM_LABELS: Record<string, [string, string]> = {
  widthM: ['Road width', 'm'],
  lanes: ['Lanes', ''],
  lengthM: ['Road length', 'm'],
  circumferenceM: ['Ring length', 'm'],
  mainWidthM: ['Main road width', 'm'],
  mainLanes: ['Main road lanes', ''],
  rampWidthM: ['Ramp width', 'm'],
  taperM: ['Acceleration lane length', 'm'],
  mainLengthM: ['Main road length', 'm'],
  rampLengthM: ['Ramp length', 'm'],
  angleDeg: ['Ramp angle', '°'],
  speedLimitMps: ['Speed limit', 'm/s'],
  control: ['Junction control', ''],
};
const FLY_LABELS: Record<string, [string, string]> = {
  deckWidthM: ['Flyover deck width', 'm'],
  rampWidthM: ['Flyover ramp width', 'm'],
  landingWidthM: ['Flyover landing width', 'm'],
  rampLengthM: ['Flyover ramp length', 'm'],
  heightM: ['Flyover height', 'm'],
  armA: ['Flyover from arm', ''],
  armB: ['Flyover to arm', ''],
};
const line = (label: string, a: unknown, b: unknown, unit = '') =>
  `${label} ${typeof a === 'number' ? fmt(a) : String(a)} → ${typeof b === 'number' ? fmt(b) : String(b)}${unit ? ` ${unit}` : ''}`;

export function describeDiff(a: ScenarioInput, b: ScenarioInput, network?: Network): string[] {
  const out: string[] = [];
  // Demand: total, and changed OD rows unless every row scaled by the same factor.
  const odA = a.od ?? [];
  const odB = b.od ?? [];
  const totA = odA.reduce((s, r) => s + r.rateVph, 0);
  const totB = odB.reduce((s, r) => s + r.rateVph, 0);
  if (Math.abs(totA - totB) > 1e-9) out.push(`Demand ${fmt(totA)} → ${fmt(totB)} veh/h`);
  const rateB = new Map(odB.map((r) => [`${r.origin}>${r.destination}`, r.rateVph]));
  const changed = odA.filter((r) => rateB.has(`${r.origin}>${r.destination}`) && Math.abs(rateB.get(`${r.origin}>${r.destination}`)! - r.rateVph) > 1e-9);
  const ratios = changed.map((r) => rateB.get(`${r.origin}>${r.destination}`)! / r.rateVph);
  const uniform = changed.length === odA.length && ratios.every((x) => Math.abs(x - ratios[0]!) <= 1e-9 * Math.max(1, Math.abs(ratios[0]!)));
  if (!uniform) {
    changed.slice(0, 3).forEach((r) => out.push(`OD ${zone(r.origin)} → ${zone(r.destination)}: ${fmt(r.rateVph)} → ${fmt(rateB.get(`${r.origin}>${r.destination}`)!)} veh/h`));
    if (changed.length > 3) out.push(`and ${changed.length - 3} more OD changes`);
  }
  const keysA = new Set(odA.map((r) => `${r.origin}>${r.destination}`));
  const addedOd = odB.filter((r) => !keysA.has(`${r.origin}>${r.destination}`)).length;
  const removedOd = odA.filter((r) => !rateB.has(`${r.origin}>${r.destination}`)).length;
  if (addedOd || removedOd) out.push(`OD pairs: ${addedOd} added, ${removedOd} removed`);

  // Composition.
  const share = (s: ScenarioInput) => {
    const c = (s.composition ?? {}) as Record<string, number>;
    const sum = Object.values(c).reduce((x, y) => x + y, 0) || 1;
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / sum]));
  };
  const sa = share(a);
  const sb = share(b);
  const mA = Math.round((sa.motorcycle ?? 0) * 100);
  const mB = Math.round((sb.motorcycle ?? 0) * 100);
  if (mA !== mB) out.push(`Motorcycle share ${mA}% → ${mB}%`);
  else {
    const other = Object.keys({ ...sa, ...sb }).find((k) => Math.abs((sa[k] ?? 0) - (sb[k] ?? 0)) > 0.005);
    if (other) out.push(`Vehicle mix changed (${other})`);
  }

  // Network.
  const ga = genOf(a);
  const gb = genOf(b);
  if (!ga || !gb) {
    if (JSON.stringify(a.network) !== JSON.stringify(b.network)) out.push('Network changed');
  } else if (ga.generator !== gb.generator) {
    out.push(line('Network type', ga.generator, gb.generator));
  } else {
    for (const [k, [label, unit]] of Object.entries(PARAM_LABELS)) {
      if (k in ga && k in gb && ga[k] !== gb[k] && typeof ga[k] !== 'object') out.push(line(label, ga[k], gb[k], unit));
    }
    const armsA = (ga.arms as Record<string, number>[] | undefined) ?? [];
    const armsB = (gb.arms as Record<string, number>[] | undefined) ?? [];
    if (armsA.length !== armsB.length) out.push(line('Arms', armsA.length, armsB.length));
    else {
      armsA.forEach((arm, i) => {
        const other = armsB[i]!;
        if (arm.inWidthM !== other.inWidthM && arm.outWidthM !== other.outWidthM && arm.inWidthM === arm.outWidthM && other.inWidthM === other.outWidthM) {
          out.push(line(`Arm ${i + 1} width`, arm.inWidthM, other.inWidthM, 'm'));
        } else {
          for (const [f, [label, unit]] of Object.entries(ARM_FIELDS)) if (arm[f] !== other[f]) out.push(line(`Arm ${i + 1} ${label}`, arm[f], other[f], unit));
        }
      });
    }
    const fa = ga.flyover as Record<string, unknown> | undefined;
    const fb = gb.flyover as Record<string, unknown> | undefined;
    const onA = Boolean(fa?.enabled);
    const onB = Boolean(fb?.enabled);
    if (onA !== onB) out.push(`Flyover ${onA ? 'on' : 'off'} → ${onB ? 'on' : 'off'}`);
    else if (onA && onB) for (const [k, [label, unit]] of Object.entries(FLY_LABELS)) if (fa![k] !== fb![k]) out.push(line(label, fa![k], fb![k], unit));
    const ca = (ga.change as Record<string, unknown> | undefined) ?? {};
    const cb = (gb.change as Record<string, unknown> | undefined) ?? {};
    if (JSON.stringify(ca) !== JSON.stringify(cb)) out.push('Road change (narrowing / lane drop) edited');
  }

  // Signals: compare greens, amber, all-red and offset by node and phase.
  const net = netOf(a, network);
  const pa = effectivePlans(a, network);
  const pb = new Map(effectivePlans(b, network).map((p) => [p.node, p]));
  for (const p of pa) {
    const q = pb.get(p.node);
    if (!q) continue;
    p.phases.forEach((ph, k) => {
      const qh = q.phases[k];
      if (qh && qh.greenS !== ph.greenS) out.push(line(`${phaseLabel(p, k, net)} green`, ph.greenS, qh.greenS, 's'));
    });
    if (p.phases.length !== q.phases.length) out.push(line('Signal phases', p.phases.length, q.phases.length));
    if (p.amberS !== q.amberS) out.push(line('Amber', p.amberS, q.amberS, 's'));
    if (p.allRedS !== q.allRedS) out.push(line('All-red', p.allRedS, q.allRedS, 's'));
    if (p.offsetS !== q.offsetS) out.push(line('Signal offset', p.offsetS, q.offsetS, 's'));
  }

  // Behaviour and run settings.
  const modeName = (m: string | undefined) => ((m ?? 'strip') === 'lane' ? 'lanes' : 'strips');
  if ((a.mode ?? 'strip') !== (b.mode ?? 'strip')) out.push(`Lateral model ${modeName(a.mode)} → ${modeName(b.mode)}`);
  if ((a.boxCompliance ?? 1) !== (b.boxCompliance ?? 1)) out.push(line('Box compliance', a.boxCompliance ?? 1, b.boxCompliance ?? 1));
  if (a.durationS !== b.durationS) out.push(line('Duration', a.durationS / 60, b.durationS / 60, 'min'));
  if ((a.warmupS ?? 300) !== (b.warmupS ?? 300)) out.push(line('Warm-up', (a.warmupS ?? 300) / 60, (b.warmupS ?? 300) / 60, 'min'));
  if ((a.dtS ?? 0.2) !== (b.dtS ?? 0.2)) out.push(line('Time step', a.dtS ?? 0.2, b.dtS ?? 0.2, 's'));
  if (a.seed !== b.seed) out.push(line('Seed', a.seed, b.seed));
  return out;
}
