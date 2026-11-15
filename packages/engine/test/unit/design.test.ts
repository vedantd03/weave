/**
 * §7.3 experiment design (stats/design.ts): runCount, pairable, welchCI, compareRuns, sweep
 * parameters, sweepValues, describeDiff.
 *
 * Assumptions (flagged):
 *  - runCount throws on an invalid design (Compare with < 2 scenarios, Sweep with 0 or > 10
 *    values); the ExperimentDesign schema also rejects them.
 *  - sweepParams entries are { id, label, unit, kind, current, from?, to?, choices? } with
 *    choices as { value, label } (or plain strings); a
 *    motorcycleShare value is in percent when unit is '%' (else a fraction).
 */
import { describe, expect, it } from 'vitest';
import { applySweep, compareRuns, describeDiff, pairable, runCount, sweepParams, sweepValues, welchCI } from '../../src/stats/design.ts';
import { pairedCI } from '../../src/stats/ci.ts';
import { tQuantile } from '../../src/stats/tdist.ts';
import { Rng } from '../../src/core/rng.ts';
import { PRESETS, defaultClasses, createSim } from '../../src/index.ts';
import { ExperimentDesign, Scenario, type ScenarioInput } from '../../src/schema/index.ts';
import { boxMuller } from '../helpers/stats-ref.ts';

type Param = { id: string; label: string; unit: string; kind: 'number' | 'choice'; current: number | string; from?: number; to?: number; choices?: (string | { value: string; label: string })[] };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const netOf = (sc: ScenarioInput) => createSim({ scenario: sc, classes: defaultClasses() }).network;
const J = () => clone(PRESETS['junction4-signal']!);

describe('runCount (§7.3)', () => {
  const sc = J();
  const common = { name: 'x', durationS: 300, warmupS: 60 };
  it('replicate = reps; compare = reps × scenarios; sweep = reps × values', () => {
    expect(runCount(ExperimentDesign.parse({ type: 'replicate', scenario: sc, reps: 3, ...common }))).toBe(3);
    const scenarios = [0, 1, 2].map((i) => ({ name: `s${i}`, scenario: sc }));
    expect(runCount(ExperimentDesign.parse({ type: 'compare', scenarios, reps: 4, ...common }))).toBe(12);
    expect(runCount(ExperimentDesign.parse({ type: 'sweep', scenario: sc, param: 'demandScale', values: [0.8, 0.9, 1, 1.1, 1.2], reps: 2, ...common }))).toBe(10);
  });
  it('rejects a compare with < 2 scenarios and a sweep with 0 or > 10 values (schema rejects; runCount throws)', () => {
    const bad = [
      { type: 'compare', scenarios: [{ name: 'only', scenario: sc }], reps: 2, ...common },
      { type: 'sweep', scenario: sc, param: 'demandScale', values: [], reps: 2, ...common },
      { type: 'sweep', scenario: sc, param: 'demandScale', values: Array.from({ length: 11 }, (_, i) => 1 + i / 10), reps: 2, ...common },
    ];
    for (const d of bad) {
      expect(ExperimentDesign.safeParse(d).success).toBe(false);
      expect(() => runCount(d as never)).toThrow();
    }
  });
});

describe('pairable (§7.3)', () => {
  it('flyover off/on and a demand-scaled copy are pairable', () => {
    const a = J();
    const b = clone(a);
    const params = (b.network as { params: Record<string, unknown> }).params;
    params.flyover = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120 };
    expect(pairable(a, b)).toEqual({ paired: true });
    const c = { ...clone(a), od: (a.od ?? []).map((r) => ({ ...r, rateVph: r.rateVph * 1.2 })) };
    expect(pairable(a, c)).toEqual({ paired: true });
  });
  it('a removed OD row → "different OD pairs"; a renamed or added origin → "different origin zones"', () => {
    const a = J();
    const od = a.od ?? [];
    expect(od.length).toBeGreaterThan(4);
    // remove one row whose origin and destination still appear in other rows
    const k = od.findIndex((r) => od.filter((x) => x.origin === r.origin).length > 1 && od.filter((x) => x.destination === r.destination).length > 1);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(pairable(a, { ...clone(a), od: od.filter((_, i) => i !== k) })).toMatchObject({ paired: false, reason: 'different OD pairs' });
    const o0 = od[0]!.origin;
    const renamed = { ...clone(a), od: od.map((r) => (r.origin === o0 ? { ...r, origin: 'renamed_in' } : r)) };
    expect(pairable(a, renamed)).toMatchObject({ paired: false, reason: 'different origin zones' });
    const added = { ...clone(a), od: [...od, { origin: 'extra_in', destination: od[0]!.destination, rateVph: 100 }] };
    expect(pairable(a, added)).toMatchObject({ paired: false, reason: 'different origin zones' });
  });
});

describe('welchCI (§7.3)', () => {
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x: number[]) => {
    const m = mean(x);
    return x.reduce((s, y) => s + (y - m) ** 2, 0) / (x.length - 1);
  };
  it('matches the Welch–Satterthwaite formula computed here', () => {
    const a = [10.2, 12.5, 9.8, 11.1, 13.0];
    const b = [14.0, 9.5, 18.2, 12.7, 16.6, 11.9, 15.3];
    const se2 = v(a) / a.length + v(b) / b.length;
    const nu = se2 ** 2 / ((v(a) / a.length) ** 2 / (a.length - 1) + (v(b) / b.length) ** 2 / (b.length - 1));
    const half = tQuantile(0.975, nu) * Math.sqrt(se2);
    const r = welchCI(a, b) as { mean: number; half: number; lo: number; hi: number; df: number };
    expect(Math.abs(r.mean - (mean(b) - mean(a)))).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(r.df - nu)).toBeLessThanOrEqual(1e-9 * nu);
    expect(Math.abs(r.half - half)).toBeLessThanOrEqual(1e-9 * half);
    expect(Math.abs(r.lo - (r.mean - r.half))).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(r.hi - (r.mean + r.half))).toBeLessThanOrEqual(1e-12);
    const r90 = welchCI(a, b, 0.9) as { half: number };
    expect(Math.abs(r90.half - tQuantile(0.95, nu) * Math.sqrt(se2))).toBeLessThanOrEqual(1e-9 * r90.half);
  });
  it('se = 0 → half 0; equal n and equal variances → ν = 2(n − 1)', () => {
    const z = welchCI([2, 2, 2], [3, 3, 3]) as { mean: number; half: number };
    expect(z.mean).toBe(1);
    expect(z.half).toBe(0);
    const e = welchCI([1, 2, 3, 4], [11, 12, 13, 14]) as { df: number };
    expect(e.df).toBeCloseTo(6, 9);
  });
  it('coverage with unequal variances (n = 5, σ = 1 vs n = 10, σ = 4) is 0.95 within 5 binomial sd + 0.01', () => {
    // Welch's interval is approximate; its coverage error for n ≥ 5 is well under 1% (Welch
    // 1947; Best & Rayner 1987), hence the extra 0.01 on top of the 5σ binomial band.
    const R = 20_000;
    const rng = new Rng(4242);
    const normal = () => boxMuller(rng.next(), rng.next())[0];
    let covered = 0;
    for (let i = 0; i < R; i++) {
      const a = Array.from({ length: 5 }, () => 10 + normal());
      const b = Array.from({ length: 10 }, () => 12 + 4 * normal());
      const c = welchCI(a, b) as { lo: number; hi: number };
      if (c.lo <= 2 && 2 <= c.hi) covered++;
    }
    expect(Math.abs(covered / R - 0.95)).toBeLessThanOrEqual(5 * Math.sqrt((0.95 * 0.05) / R) + 0.01);
  });
});

describe('compareRuns (§7.3)', () => {
  it('paired → pairedCI per metric; unpaired → welchCI; they differ on correlated data', () => {
    const base = [10, 20, 30, 40, 50].map((x, i) => ({ seed: i, metrics: { meanDelayS: x, throughputVph: 1000 + 10 * x } }));
    const variant = base.map((r, i) => ({ seed: i, metrics: { meanDelayS: r.metrics.meanDelayS + 1 + 0.1 * (i % 2), throughputVph: r.metrics.throughputVph - 5 } }));
    const p = compareRuns(base as never, variant as never, true) as Record<string, { half: number; mean: number }>;
    const u = compareRuns(base as never, variant as never, false) as Record<string, { half: number; mean: number }>;
    for (const k of ['meanDelayS', 'throughputVph']) {
      const a = base.map((r) => r.metrics[k as 'meanDelayS']);
      const b = variant.map((r) => r.metrics[k as 'meanDelayS']);
      expect(p[k]).toEqual(pairedCI(a, b));
      expect(u[k]).toEqual(welchCI(a, b));
    }
    expect(p.meanDelayS!.half).toBeLessThan(u.meanDelayS!.half);
  });
});

describe('sweep parameters (§7.3)', () => {
  const prefixes = (ps: Param[]) => new Set(ps.map((p) => p.id.split(':')[0]));
  const params = (id: string) => {
    const sc = clone(PRESETS[id]!);
    const net = netOf(sc);
    return { sc, net, ps: sweepParams(sc, net) as unknown as Param[] };
  };

  it('lists exactly the applicable parameters', () => {
    expect(prefixes(params('junction4-flyover').ps)).toEqual(new Set(['armWidth', 'green', 'rampLength', 'flyover', 'mode', 'demandScale', 'motorcycleShare']));
    const ring = prefixes(params('ring-demo').ps);
    for (const no of ['green', 'flyover', 'demandScale', 'rampLength']) expect(ring.has(no), no).toBe(false);
    expect(ring.has('width')).toBe(true);
    expect(ring.has('mode')).toBe(true);
    const merge = prefixes(params('merge-onramp').ps);
    for (const yes of ['accelLength', 'mainWidth', 'rampWidth']) expect(merge.has(yes), yes).toBe(true);
  });

  for (const id of ['junction4-flyover', 'ring-demo', 'merge-onramp', 'corridor-lanedrop']) {
    it(`${id}: applySweep changes only its field (describeDiff has exactly one line)`, () => {
      const { sc, net, ps } = params(id);
      for (const p of ps) {
        let value: number | string;
        if (p.kind === 'choice') value = p.choices!.map((c) => (typeof c === 'string' ? c : c.value)).find((c) => c !== p.current)!;
        else if (p.id === 'motorcycleShare') value = p.unit === '%' ? 40 : 0.4;
        else value = Math.round(((p.current as number) * 1.1 + 0.5) * 100) / 100;
        const out = applySweep(sc, net, p.id, value) as ScenarioInput;
        expect(Scenario.safeParse(out).success, p.id).toBe(true);
        const lines = describeDiff(sc, out, net);
        expect(lines.length, `${p.id}: ${lines.join(' | ')}`).toBe(1);
        const gp = (s: ScenarioInput) => (s.network as { params: Record<string, any> }).params; // eslint-disable-line @typescript-eslint/no-explicit-any
        const [kind, a, b] = p.id.split(':');
        switch (kind) {
          case 'demandScale':
            (out.od ?? []).forEach((r, i) => expect(Math.abs(r.rateVph - (sc.od ?? [])[i]!.rateVph * (value as number))).toBeLessThanOrEqual(1e-9 * r.rateVph));
            break;
          case 'motorcycleShare': {
            const c = out.composition as Record<string, number>;
            const c0 = sc.composition as Record<string, number>;
            const tot = Object.values(c).reduce((s, x) => s + x, 0);
            expect(Math.abs(tot - 1)).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(c.motorcycle! - (p.unit === '%' ? (value as number) / 100 : (value as number)))).toBeLessThanOrEqual(1e-9);
            const others = Object.keys(c0).filter((k) => k !== 'motorcycle' && (c0[k] ?? 0) > 0);
            for (let i = 1; i < others.length; i++) {
              expect(Math.abs(c[others[i]!]! / c[others[0]!]! - c0[others[i]!]! / c0[others[0]!]!)).toBeLessThanOrEqual(1e-9);
            }
            break;
          }
          case 'green': {
            const node = a!;
            const k = Number(b);
            const plan = (out.signalOverrides ?? []).find((x) => x.node === node)!;
            expect(plan.phases[k]!.greenS).toBe(value);
            break;
          }
          case 'armWidth':
            expect([gp(out).arms[Number(a)].inWidthM, gp(out).arms[Number(a)].outWidthM]).toEqual([value, value]);
            break;
          case 'width':
            expect(gp(out).widthM).toBe(value);
            break;
          case 'mainWidth':
            expect(gp(out).mainWidthM).toBe(value);
            break;
          case 'rampWidth':
            expect(gp(out).rampWidthM).toBe(value);
            break;
          case 'rampLength':
            expect(gp(out).flyover.rampLengthM).toBe(value);
            break;
          case 'accelLength':
            expect(gp(out).taperM).toBe(value);
            break;
          case 'flyover':
            expect(gp(out).flyover?.enabled ?? false).toBe(value === 'on');
            break;
          case 'mode':
            expect(out.mode).toBe(value);
            break;
          default:
            throw new Error(`unexpected parameter ${p.id}`);
        }
      }
    });
  }

  it('sweepValues: evenly spaced inclusive; one step gives [from]', () => {
    const v = sweepValues(1, 2, 5);
    expect(v.length).toBe(5);
    [1, 1.25, 1.5, 1.75, 2].forEach((x, i) => expect(Math.abs(v[i]! - x)).toBeLessThanOrEqual(1e-12));
    expect(sweepValues(3, 7, 1)).toEqual([3]);
  });
});

describe('describeDiff (§7.3)', () => {
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  it('[] for identical scenarios', () => {
    const a = J();
    expect(describeDiff(a, clone(a), netOf(a))).toEqual([]);
  });
  it('demand scale 1.2 → "Demand X → 1.2X veh/h"', () => {
    const a = J();
    const total = (a.od ?? []).reduce((s, r) => s + r.rateVph, 0);
    const b = { ...clone(a), od: (a.od ?? []).map((r) => ({ ...r, rateVph: r.rateVph * 1.2 })) };
    expect(describeDiff(a, b, netOf(a))).toEqual([`Demand ${fmt(total)} → ${fmt(total * 1.2)} veh/h`]);
  });
  it('a phase green 25 → 35 s reads "Arm 2 green …" or "Phase 2 green …"', () => {
    const a = J();
    const net = netOf(a);
    const plan = net.signals[0]!;
    expect(plan.phases[1]!.greenS).toBe(25);
    const b = { ...clone(a), signalOverrides: [{ ...plan, phases: plan.phases.map((ph, i) => (i === 1 ? { ...ph, greenS: 35 } : ph)) }] };
    const lines = describeDiff(a, b, net);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^(Arm|Phase) 2 green 25 → 35 s$/);
  });
  it('"Flyover off → on"', () => {
    const a = J();
    const b = clone(a);
    (b.network as { params: Record<string, unknown> }).params.flyover = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120 };
    expect(describeDiff(a, b, netOf(a))).toEqual(['Flyover off → on']);
  });
});
