/**
 * Revision-2 metrics (docs/MODEL.md §1.4 "Where and how far", §5.2): queueGrowing,
 * divertedTrips, guardPer1000VehKm, diagnostics().vehicleKm and diagnostics().guardBySegment.
 * Every expectation is recomputed from an independent createSim run with the same seed.
 */
import { describe, expect, it } from 'vitest';
import silk from '../../../../apps/web/public/data/silkboard.json' with { type: 'json' };
import { runReplicate } from '../../src/stats/experiment.ts';
import { PRESETS, defaultClasses } from '../../src/index.ts';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';
import { ARM, junctionScenario, type M3Sim } from '../helpers/m3.ts';

const DT = 0.2;
type Diag = { guardActivations: number; diversions: number; vehicleKm: number; guardBySegment: Record<string, number> };
const diag = (sim: M3Sim) => sim.diagnostics() as unknown as Diag;
type Metrics = Record<string, number>;
const metrics = (r: unknown) => (r as { metrics: Metrics }).metrics;

const CLASSES = classSet([
  { id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } },
  { id: 'motorcycle', length: 2, width: 0.8, idm: { v0: 13, T: 1.0, s0: 1.5, a: 2, b: 2.5 } },
]);
const lambdaOf = (sc: ScenarioInput) => (sc.od ?? []).reduce((a, r) => a + r.rateVph, 0) / 3600;

/** All-red junction: a plan whose only phase protects nothing, so no vehicle ever crosses. */
function allRedJunction(ratePerArm: number): ScenarioInput {
  const arms = [ARM(0), ARM(90), ARM(180), ARM(270)];
  const node = makeSim(junctionScenario({ arms }), CLASSES).network.signals[0]!.node;
  const od = [0, 1, 2, 3].map((k) => ({ origin: `arm${k}_in`, destination: `arm${(k + 2) % 4}_out`, rateVph: ratePerArm }));
  return {
    ...junctionScenario({ arms, od, signalOverrides: [{ node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: 60, protected: [] }] }] }),
    durationS: 1200,
    warmupS: 120,
  };
}
const lightCorridor = (): ScenarioInput => ({
  ...corridorScenario({ lengthM: 800, widthM: 3.5, lanes: 1, rateVph: 300, mode: 'lane', composition: { car: 0.7, motorcycle: 0.3 } }),
  durationS: 900,
  warmupS: 120,
});

/** Q(durationS) − Q(m) from an independent run, m = warmupS + (durationS − warmupS)/2 rounded down to a step. */
function queueRule(sc: ScenarioInput, seed: number, network?: Network, classes = CLASSES) {
  const sim = makeSim({ ...sc, seed }, classes, network);
  const m = sc.warmupS! + (sc.durationS - sc.warmupS!) / 2;
  const nm = Math.floor(m / DT + 1e-9);
  const nD = Math.round(sc.durationS / DT);
  sim.advance(nm);
  const qm = sim.counters().entryQueue;
  sim.advance(nD - nm);
  const qD = sim.counters().entryQueue;
  const threshold = Math.max(10, 60 * lambdaOf(sc));
  return { growth: qD - qm, threshold, flag: qD - qm > threshold ? 1 : 0 };
}

describe('queueGrowing (§5.2)', () => {
  it('oversaturated (all-red junction): growth ≥ arrivals − storage ≫ threshold → 1', () => {
    // 4 × 1500 veh/h, λ = 1.667 veh/s, threshold max(10, 60λ) = 100. Nothing ever leaves, so in
    // (m, D] the network can absorb at most its storage: four 250 m approaches hold at most
    // 4·(⌊250/ℓ_min⌋ + 1) = 504 non-overlapping vehicles (ℓ_min = 2 m). Arrivals in the 540 s
    // second half are Poisson(900), ≥ 900 − 5·30 = 750 at 5σ, so Q(D) − Q(m) ≥ 750 − 504 = 246 > 100.
    const sc = allRedJunction(1500);
    const rule = queueRule(sc, 4);
    expect(rule.growth).toBeGreaterThan(rule.threshold);
    expect(metrics(runReplicate({ scenario: sc, classes: CLASSES }, 4)).queueGrowing).toBe(1);
  });

  it('light (single lane at 300 veh/h, far below insertion capacity): Q stays ≈ 0 → 0', () => {
    // Q > 10 would need 11 arrivals within the ~3 s insertion headway of one vehicle:
    // Poisson(λ·3 s = 0.25) P(N ≥ 11) < 1e-15.
    const sc = lightCorridor();
    const rule = queueRule(sc, 4);
    expect(rule.growth).toBeLessThanOrEqual(rule.threshold);
    expect(metrics(runReplicate({ scenario: sc, classes: CLASSES }, 4)).queueGrowing).toBe(0);
  });

  it('exact rule: queueGrowing = [Q(D) − Q(m) > max(10, 60·λ)] for several scenarios and seeds', () => {
    const cases: ScenarioInput[] = [
      allRedJunction(1500),
      allRedJunction(120),
      lightCorridor(),
      { ...corridorScenario({ lengthM: 300, widthM: 3.5, lanes: 1, rateVph: 4000, mode: 'lane', composition: { car: 0.7, motorcycle: 0.3 } }), durationS: 900, warmupS: 120 },
    ];
    for (const sc of cases) {
      for (const seed of [1, 2]) {
        const rule = queueRule(sc, seed);
        expect(metrics(runReplicate({ scenario: sc, classes: CLASSES }, seed)).queueGrowing, `${sc.id} seed ${seed}: growth ${rule.growth}`).toBe(rule.flag);
      }
    }
  });
});

describe('divertedTrips (§5.2)', () => {
  const net = Network.parse(silk);
  const silkSc = (): ScenarioInput => ({ ...PRESETS['silkboard']!, durationS: 1200, warmupS: 120 });

  it('equals diversions(durationS) − diversions(warmupS) of an independent run (Silk Board: > 0)', () => {
    const sc = silkSc();
    const sim = makeSim(sc, defaultClasses(), net) as unknown as M3Sim;
    sim.advance(Math.round(sc.warmupS! / DT));
    const d0 = diag(sim).diversions;
    sim.advance(Math.round((sc.durationS - sc.warmupS!) / DT));
    const d1 = diag(sim).diversions;
    expect(d1 - d0).toBeGreaterThan(0);
    expect(metrics(runReplicate({ scenario: sc, classes: defaultClasses(), network: net }, sc.seed)).divertedTrips).toBe(d1 - d0);
  });

  it('is 0 where no diversion is possible (a single-link corridor)', () => {
    expect(metrics(runReplicate({ scenario: lightCorridor(), classes: CLASSES }, 3)).divertedTrips).toBe(0);
  });
});

describe('vehicle-km and guard per distance (§1.4, §5.2)', () => {
  it('vehicleKm on a single link: Σ_exited (L − ℓ) + Σ_on-link (s − ℓ), plus at most v·dt overshoot per exit', () => {
    // A front is inserted at s = ℓ; ds summed per step telescopes to the distance travelled. An
    // exiting vehicle's last step carries it past the end by less than its step displacement
    // ≤ v_max·dt, which the lower bound does not count.
    const sc = lightCorridor();
    const L = 800;
    const sim = makeSim({ ...sc, seed: 5 }, CLASSES) as unknown as M3Sim;
    sim.advance(Math.round(sc.durationS / DT));
    const len = new Map(sim.generatedLog().map((r) => [r.id, r.length]));
    const exited = sim.trips();
    const base = exited.reduce((a, t) => a + (L - len.get(t.id)!), 0) + sim.vehicles().reduce((a, v) => a + (v.s - len.get(v.id)!), 0);
    const vmax = 13; // the faster class's v0 (speed limit 40)
    const km = diag(sim).vehicleKm;
    expect(exited.length).toBeGreaterThan(20);
    expect(km * 1000).toBeGreaterThanOrEqual(base - 1e-6);
    expect(km * 1000).toBeLessThanOrEqual(base + exited.length * vmax * DT + 1e-6);
  });

  it('guardBySegment: segment-id keys, no zero entries, sum = guardActivations; guardPer1000VehKm = 1000·guard/vehicleKm', () => {
    const sc: ScenarioInput = { ...PRESETS['silkboard']!, durationS: 1200, warmupS: 120 };
    const net = Network.parse(silk);
    const sim = makeSim(sc, defaultClasses(), net) as unknown as M3Sim;
    sim.advance(Math.round(sc.durationS / DT));
    const d = diag(sim);
    expect(d.guardActivations).toBeGreaterThan(0); // premise: the map is not trivially empty
    const segments = new Set([...net.links.map((l) => l.id), ...net.movements.map((m) => m.id)]);
    let sum = 0;
    for (const [seg, n] of Object.entries(d.guardBySegment)) {
      expect(segments.has(seg), seg).toBe(true);
      expect(n).toBeGreaterThan(0);
      expect(Number.isInteger(n)).toBe(true);
      sum += n;
    }
    expect(sum).toBe(d.guardActivations);
    const m = metrics(runReplicate({ scenario: sc, classes: defaultClasses(), network: net }, sc.seed));
    const expected = (1000 * d.guardActivations) / d.vehicleKm;
    expect(Math.abs(m.guardPer1000VehKm! - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, expected));
  });
});
