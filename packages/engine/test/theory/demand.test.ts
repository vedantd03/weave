/**
 * Demand, generation and routes (docs/MODEL.md §2.1).
 *
 * Statistical checks use fixed seeds (deterministic) with thresholds at 5σ, or chi-square
 * critical values at p = 0.001, so a correct implementation passes by a wide margin.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type ClassSpec, type M2Sim } from '../helpers/m2.ts';
import { divergeNetwork, fileScenario, parallelNetwork } from '../helpers/networks.ts';
import { Z_999, chiSquareCritical } from '../helpers/numeric.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };
const SPECS: ClassSpec[] = [
  { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2 },
  { id: 'motorcycle', length: 2, width: 0.8, idm: { ...IDM, v0: 16 }, c0: 0.15 },
  { id: 'auto', length: 3, width: 1.4, idm: { ...IDM, v0: 12 }, c0: 0.2 },
];
const CLASSES = classSet(SPECS);

describe('arrivals (Poisson process per origin)', () => {
  const RATE = 1200; // veh/h → λ = 1/3 veh/s
  const HOURS = 1;
  const DT = 0.2;
  let sim: M2Sim;
  const newPerStep: { step: number; tGen: number }[] = [];

  it('runs one hour of demand (setup)', () => {
    sim = makeSim(corridorScenario({ lengthM: 300, widthM: 10.5, lanes: 3, rateVph: RATE, mode: 'lane', seed: 2024 }), CLASSES);
    let logged = 0;
    for (let k = 1; k <= (HOURS * 3600) / DT; k++) {
      sim.advance(1);
      if (k <= 2000) {
        const log = sim.generatedLog();
        for (let i = logged; i < log.length; i++) newPerStep.push({ step: k, tGen: log[i]!.tGen });
        logged = log.length;
      }
    }
    expect(sim.t).toBeCloseTo(3600, 9);
  });

  it('ids are originIndex·2^20 + k in generation order; tGen increasing; log length = generated', () => {
    const log = sim.generatedLog();
    expect(log.length).toBe(sim.counters().generated);
    log.forEach((r, k) => {
      expect(r.id).toBe(0 * 2 ** 20 + k); // single origin: index 0
      expect(r.origin).toBe('in');
      expect(r.destination).toBe('out');
      if (k > 0) expect(r.tGen).toBeGreaterThan(log[k - 1]!.tGen);
    });
    expect(log[0]!.tGen).toBeGreaterThan(0);
    expect(log[log.length - 1]!.tGen).toBeLessThanOrEqual(sim.t + 1e-9);
  });

  it('a vehicle appears in the step whose end time first reaches its arrival time', () => {
    // generated at the end of step n iff T_k ≤ t_n = n·dt and it was not generated before:
    // tGen ∈ ((n − 1)·dt, n·dt] (slack 1e-9 for t = n·dt rounding)
    expect(newPerStep.length).toBeGreaterThan(50);
    for (const { step, tGen } of newPerStep) {
      expect(tGen).toBeGreaterThan((step - 1) * DT - 1e-9);
      expect(tGen).toBeLessThanOrEqual(step * DT + 1e-9);
    }
  });

  it('count over the hour ~ Poisson(λT): within 5σ; 60 one-minute counts pass a dispersion test', () => {
    const log = sim.generatedLog();
    const mu = (RATE / 3600) * 3600 * HOURS; // 1200
    expect(Math.abs(log.length - mu)).toBeLessThan(5 * Math.sqrt(mu));
    const counts = new Array<number>(60).fill(0);
    for (const r of log) counts[Math.min(59, Math.floor(r.tGen / 60 - 1e-12))]!++;
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    // Index of dispersion Σ(n_i − n̄)²/n̄ ~ χ²_59 for Poisson counts; reject outside the
    // p = 0.001 tails (Wilson–Hilferty critical values, ≈ 27.8 and 101.8).
    const D = counts.reduce((a, n) => a + ((n - mean) * (n - mean)) / mean, 0);
    expect(D).toBeLessThan(chiSquareCritical(59, Z_999));
    expect(D).toBeGreaterThan(chiSquareCritical(59, -Z_999));
  });

  it('interarrival times ~ Exp(λ): mean 1/λ and squared CV 1 within 5σ', () => {
    const log = sim.generatedLog();
    const gaps = [log[0]!.tGen, ...log.slice(1).map((r, i) => r.tGen - log[i]!.tGen)];
    const n = gaps.length;
    const m = gaps.reduce((a, b) => a + b, 0) / n;
    const v = gaps.reduce((a, g) => a + (g - m) * (g - m), 0) / n;
    // sd(mean) = (1/λ)/√n; for Exp, sd(sample variance) ≈ √(8/n)/λ² so sd(v/m²) ≈ √(8/n)
    expect(Math.abs(m - 3)).toBeLessThan((5 * 3) / Math.sqrt(n));
    expect(Math.abs(v / (m * m) - 1)).toBeLessThan(5 * Math.sqrt(8 / n));
  });
});

describe('destination and class draws', () => {
  it('destination split follows OD rates (binomial 5σ) and class split follows composition (χ², p = 0.001)', () => {
    const sim = makeSim(
      fileScenario({
        od: [
          { origin: 'in', destination: 'out1', rateVph: 900 },
          { origin: 'in', destination: 'out2', rateVph: 300 },
        ],
        composition: { car: 0.5, motorcycle: 0.3, auto: 0.2 },
        mode: 'lane',
        seed: 31,
      }),
      CLASSES,
      divergeNetwork(),
    );
    sim.advance(9000); // 1800 s
    const log = sim.generatedLog();
    const n = log.length;
    expect(n).toBeGreaterThan(500); // λT = 600; 5σ lower bound 478
    const n1 = log.filter((r) => r.destination === 'out1').length;
    const n2 = log.filter((r) => r.destination === 'out2').length;
    expect(n1 + n2).toBe(n);
    const p1 = 900 / 1200;
    expect(Math.abs(n1 - p1 * n)).toBeLessThan(5 * Math.sqrt(n * p1 * (1 - p1)));

    const shares: Record<string, number> = { car: 0.5, motorcycle: 0.3, auto: 0.2 };
    let chi2 = 0;
    for (const [cls, p] of Object.entries(shares)) {
      const obs = log.filter((r) => r.classId === cls).length;
      chi2 += (obs - n * p) ** 2 / (n * p);
    }
    // df = 2: the χ² survival function is exp(−x/2), so the p = 0.001 critical value is
    // exactly −2·ln(0.001) = 13.8155.
    expect(chi2).toBeLessThan(-2 * Math.log(0.001));

    // sizes and parameters come from the class (spread 0, fixed sizes)
    const spec = new Map(SPECS.map((s) => [s.id, s]));
    for (const r of log) {
      const s = spec.get(r.classId)!;
      expect([r.length, r.width, r.v0, r.T, r.s0, r.a, r.b]).toEqual([s.length, s.width, s.idm.v0, s.idm.T, s.idm.s0, s.idm.a, s.idm.b]);
    }

    // completed trips leave at their drawn destination
    const dest = new Map(log.map((r) => [r.id, r.destination]));
    const trips = sim.trips();
    expect(trips.length).toBeGreaterThan(0.8 * n); // ~35 s trips in a 1800 s run
    for (const t of trips) {
      expect(t.destination).toBe(dest.get(t.id));
      expect(t.origin).toBe('in');
      expect(t.tExit).toBeGreaterThan(t.tInsert);
      expect(t.tInsert).toBeGreaterThanOrEqual(t.tGen);
    }
  });
});

describe('routes', () => {
  function linksVisited(sim: M2Sim, steps: number): Set<string> {
    const seen = new Set<string>();
    for (let k = 0; k < steps; k++) {
      sim.advance(1);
      for (const v of sim.vehicles()) seen.add(v.link);
    }
    return seen;
  }
  const od = [{ origin: 'in', destination: 'out', rateVph: 600 }];

  it('cost is Σ length / speed limit: the longer but faster path wins', () => {
    // b: 492.0 m at 20 m/s = 24.6 s; c: 390 m at 10 m/s = 39 s → b
    const sim = makeSim(fileScenario({ od, composition: { car: 1 } }), CLASSES, parallelNetwork(20, 10));
    const seen = linksVisited(sim, 1500);
    expect(seen.has('b')).toBe(true);
    expect(seen.has('c')).toBe(false);
    expect(sim.trips().length).toBeGreaterThan(0);
  });

  it('…and the shorter path wins when it is cheaper', () => {
    // b: 492.0 m at 5 m/s = 98.4 s; c: 390 m at 10 m/s = 39 s → c
    const sim = makeSim(fileScenario({ od, composition: { car: 1 } }), CLASSES, parallelNetwork(5, 10));
    const seen = linksVisited(sim, 1500);
    expect(seen.has('c')).toBe(true);
    expect(seen.has('b')).toBe(false);
  });

  it('corridor with a lane drop: up → taper → down, then exit at out', () => {
    const sim = makeSim(
      corridorScenario({
        lengthM: 600,
        widthM: 7,
        lanes: 2,
        change: { kind: 'laneDrop', atM: 250, dropLanes: 1, taperM: 50 },
        rateVph: 300,
        mode: 'lane',
        seed: 4,
      }),
      CLASSES,
    );
    const seq = new Map<number, string[]>();
    for (let k = 0; k < 2000; k++) {
      sim.advance(1);
      for (const v of sim.vehicles()) {
        const s = seq.get(v.id) ?? [];
        if (s[s.length - 1] !== v.link) s.push(v.link);
        seq.set(v.id, s);
      }
    }
    const done = new Set(sim.trips().map((t) => t.id));
    expect(done.size).toBeGreaterThan(5);
    for (const t of sim.trips()) expect(t.destination).toBe('out');
    for (const [id, s] of seq) if (done.has(id)) expect(s).toEqual(['up', 'taper', 'down']);
  });

  it('an OD pair with positive rate and no path makes createSim throw', () => {
    expect(() =>
      makeSim(
        fileScenario({ od: [{ origin: 'in2', destination: 'out2', rateVph: 100 }], composition: { car: 1 } }),
        CLASSES,
        divergeNetwork(true),
      ),
    ).toThrow();
  });
});
