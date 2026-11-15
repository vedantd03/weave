/**
 * §7.1 networkGrowing and §7.2 breakdowns.
 *
 * networkGrowing = [onNetwork(D) − onNetwork(m) > max(10, 60·λ)], m = warmupS + (D − warmupS)/2
 * rounded down to a step, λ = Σ rateVph / 3600; onNetwork(step) from sim.historyAt(step).
 *
 * Assumptions (flagged): breakdown(sim, warmupS) returns { approaches, movements, od } with
 * approach rows carrying `zone` (the origin zone id), `generated`, `completed`, `throughputVph`; OD rows carrying
 * `origin`, `destination`, `generated`; trips "in the window" are those with tGen ∈ [warmupS, t].
 */
import { describe, expect, it } from 'vitest';
import silk from '../../../../apps/web/public/data/silkboard.json' with { type: 'json' };
import { breakdown } from '../../src/stats/breakdown.ts';
import { runReplicate } from '../../src/stats/experiment.ts';
import { PRESETS, defaultClasses } from '../../src/index.ts';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { makeSim } from '../helpers/m2.ts';

const DT = 0.2;
type Hist = { historyAt(step: number): { onNetwork: number } };
const silkNet = Network.parse(silk);

describe('networkGrowing (§7.1)', () => {
  const sc: ScenarioInput = { ...PRESETS['silkboard']!, seed: 58 };

  it('Silk Board, seed 58: networkGrowing 1, gridlocked 0, queueGrowing 0', { timeout: 300_000 }, () => {
    const m = (runReplicate({ scenario: sc, classes: defaultClasses(), network: silkNet }, 58) as { metrics: Record<string, number> }).metrics;
    expect(m.networkGrowing).toBe(1);
    expect(m.gridlocked).toBe(0);
    expect(m.queueGrowing).toBe(0);
  });

  it('exact rule from historyAt(step).onNetwork', { timeout: 300_000 }, () => {
    for (const [scen, net] of [
      [sc, silkNet],
      [{ ...PRESETS['junction4-signal']!, durationS: 600, warmupS: 120 }, undefined],
    ] as const) {
      const sim = makeSim(scen, defaultClasses(), net as Network | undefined) as unknown as Hist & { advance(n: number): void };
      const D = scen.durationS;
      const w = scen.warmupS ?? 300;
      const nD = Math.round(D / DT);
      sim.advance(nD);
      const nm = Math.floor((w + (D - w) / 2) / DT + 1e-9);
      const lambda = (scen.od ?? []).reduce((s, r) => s + r.rateVph, 0) / 3600;
      const growth = sim.historyAt(nD).onNetwork - sim.historyAt(nm).onNetwork;
      const flag = growth > Math.max(10, 60 * lambda) ? 1 : 0;
      const m = (runReplicate({ scenario: scen, classes: defaultClasses(), ...(net ? { network: net } : {}) }, scen.seed) as { metrics: Record<string, number> }).metrics;
      expect(m.networkGrowing, `${scen.id}: growth ${growth}`).toBe(flag);
    }
  });
});

describe('breakdown (§7.2)', () => {
  type Row = Record<string, number | string | null>;
  type B = { approaches: Row[]; movements: Row[]; od: Row[] | null };

  it('junction4-signal: approach and OD sums equal the window generated count; throughput per approach', () => {
    const sc: ScenarioInput = { ...PRESETS['junction4-signal']!, durationS: 600, warmupS: 120 };
    const sim = makeSim(sc, defaultClasses());
    sim.advance(Math.round(600 / DT));
    const w = 120;
    const b = breakdown(sim as never, w) as unknown as B;
    const inW = (t: number) => t >= w && t <= sim.t;
    const gen = sim.generatedLog().filter((r) => inW(r.tGen));
    const done = sim.trips().filter((t) => inW(t.tGen));
    expect(b.approaches.reduce((s, r) => s + (r.generated as number), 0)).toBe(gen.length);
    expect(b.od).not.toBeNull();
    expect((sc.od ?? []).length).toBeLessThanOrEqual(40);
    expect(b.od!.length).toBe((sc.od ?? []).length);
    expect(b.od!.reduce((s, r) => s + (r.generated as number), 0)).toBe(gen.length);
    for (const a of b.approaches) {
      const n = done.filter((t) => t.origin === a.zone).length;
      expect(a.completed).toBe(n);
      expect(Math.abs((a.throughputVph as number) - (n * 3600) / (sim.t - w))).toBeLessThanOrEqual(1e-9 * Math.max(1, n));
    }
    expect(b.movements.length).toBeGreaterThan(0);
  });

  it('Silk Board: more than 40 OD pairs → od is null; approach sums still hold', { timeout: 300_000 }, () => {
    const sc: ScenarioInput = { ...PRESETS['silkboard']!, durationS: 600, warmupS: 120 };
    expect((sc.od ?? []).length).toBeGreaterThan(40);
    const sim = makeSim(sc, defaultClasses(), silkNet);
    sim.advance(Math.round(600 / DT));
    const b = breakdown(sim as never, 120) as unknown as B;
    expect(b.od).toBeNull();
    const gen = sim.generatedLog().filter((r) => r.tGen >= 120 && r.tGen <= sim.t);
    expect(b.approaches.reduce((s, r) => s + (r.generated as number), 0)).toBe(gen.length);
  });
});
