/**
 * §6.2 run summary and per-segment statistics (stats/summary.ts).
 *  - runSummary(sim at durationS, warmupS) equals runReplicate exactly.
 *  - queueAt(step) is counters().entryQueue right after that step (0 at step 0).
 *  - segmentStats: Σ vehicleKm = diagnostics().vehicleKm (float rounding, 1e-9 relative);
 *    meanFlowVph = meanDensityPerKm · meanSpeedKmh (Edie identity, both over [0, t]);
 *    vehicleHours = linkStats().vehicleSeconds/3600; onNow = vehicles with that link;
 *    Σ guardActivations = diagnostics().guardActivations; one entry per link and movement.
 */
import { describe, expect, it } from 'vitest';
import silk from '../../../../apps/web/public/data/silkboard.json' with { type: 'json' };
import { runSummary, segmentStats } from '../../src/stats/summary.ts';
import { runReplicate } from '../../src/stats/experiment.ts';
import { PRESETS, defaultClasses } from '../../src/index.ts';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { corridorScenario, linkStat, makeSim, classSet } from '../helpers/m2.ts';
import { plen, type M3Sim } from '../helpers/m3.ts';

const DT = 0.2;
type AnySim = M3Sim & { queueAt(step: number): number };
const rel = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe('runSummary', () => {
  for (const id of ['corridor-lanedrop', 'junction4-signal']) {
    it(`${id}: runSummary(sim at durationS, warmupS) equals runReplicate exactly`, () => {
      const sc: ScenarioInput = { ...PRESETS[id]!, durationS: 600, warmupS: 120 };
      const seed = sc.seed;
      const sim = makeSim({ ...sc, seed }, defaultClasses());
      sim.advance(Math.round(sc.durationS / DT));
      const s = runSummary(sim as never, sc.warmupS!);
      const r = runReplicate({ scenario: sc, classes: defaultClasses() }, seed);
      expect(s).toEqual(r.metrics);
    });
  }
});

describe('queueAt', () => {
  it('equals counters().entryQueue right after every step; 0 at step 0', () => {
    const sim = makeSim(
      corridorScenario({ lengthM: 300, widthM: 3.5, lanes: 1, rateVph: 4000, mode: 'lane' }),
      classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]),
    ) as unknown as AnySim;
    const q: number[] = [0];
    for (let k = 1; k <= 1500; k++) {
      sim.advance(1);
      q.push(sim.counters().entryQueue);
    }
    expect(Math.max(...q)).toBeGreaterThan(10); // premise: a real, changing queue
    for (let k = 0; k <= 1500; k++) expect(sim.queueAt(k), `step ${k}`).toBe(q[k]);
  });
});

describe('segmentStats', () => {
  it('Silk Board (20 min): sums, identities and one entry per segment', () => {
    const net = Network.parse(silk);
    const sc: ScenarioInput = { ...PRESETS['silkboard']!, durationS: 1200 };
    const sim = makeSim(sc, defaultClasses(), net) as unknown as AnySim;
    sim.advance(Math.round(1200 / DT));
    const st = segmentStats(sim as never);
    const d = sim.diagnostics() as unknown as { vehicleKm: number; guardActivations: number };
    const ids = [...net.links.map((l) => l.id), ...net.movements.map((m) => m.id)];
    expect(st.map((x) => x.id).sort()).toEqual([...ids].sort());
    const vs = sim.vehicles();
    let km = 0;
    let guard = 0;
    for (const x of st) {
      const link = net.links.find((l) => l.id === x.id);
      const mv = net.movements.find((m) => m.id === x.id);
      expect(x.kind).toBe(link ? 'link' : 'movement');
      expect(Math.abs(x.lengthM - plen(link ? link.polyline : mv!.path))).toBeLessThanOrEqual(1e-9 * Math.max(1, x.lengthM));
      expect(x.widthM).toBe(link ? link.widthM : mv!.widthM);
      const ls = linkStat(sim, x.id);
      expect([x.entered, x.exited]).toEqual([ls.entered, ls.exited]);
      expect(rel(x.vehicleHours, ls.vehicleSeconds / 3600)).toBe(true);
      expect(x.onNow).toBe(vs.filter((v) => v.link === x.id).length);
      if (x.vehicleHours > 0) {
        expect(rel(x.meanSpeedKmh, x.vehicleKm / x.vehicleHours)).toBe(true);
        expect(rel(x.meanFlowVph, x.meanDensityPerKm * x.meanSpeedKmh)).toBe(true);
        // Edie over [0, t]: density = vehicleHours / (L_km · t_h)
        expect(rel(x.meanDensityPerKm, x.vehicleHours / ((x.lengthM / 1000) * (sim.t / 3600)))).toBe(true);
      } else {
        expect(x.meanSpeedKmh).toBeNaN();
      }
      km += x.vehicleKm;
      guard += x.guardActivations;
    }
    expect(Math.abs(km - d.vehicleKm)).toBeLessThanOrEqual(1e-9 * Math.max(1, d.vehicleKm));
    expect(guard).toBe(d.guardActivations);
  });
});
