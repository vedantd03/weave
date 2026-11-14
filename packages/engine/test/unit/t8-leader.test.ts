/**
 * T8 — leader rule (docs/MODEL.md §1.6): shared fixture, a brute-force property, and the
 * across-link-end case on the ring (§1.6 "Across link ends", §1.7).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { findLeaders, type LeaderInput } from '../../src/sim/leader.ts';
import { laneLayout, laneStrip, occupiedStrips, stripLayout } from '../../src/network/strips.ts';
import { createSim } from '../../src/sim/sim.ts';
import fixtureJson from '../../../../docs/fixtures/leader_cases.json';
import { caseLayout, caseStrips, leadersRef, type FixtureCase } from '../helpers/strips-ref.ts';
import { idmRef, type Idm } from '../helpers/idm-theory.ts';
import { ringClassSet, ringCount, ringScenario } from '../helpers/ring.ts';
import { wrap } from '../helpers/numeric.ts';

const cases = (fixtureJson as unknown as { cases: FixtureCase[] }).cases;

function toIds(c: FixtureCase, leaders: ArrayLike<number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  c.vehicles.forEach((v, i) => {
    const l = leaders[i]!;
    out[String(v.id)] = l < 0 ? null : c.vehicles[l]!.id;
  });
  return out;
}

function expectedIds(c: FixtureCase): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const v of c.vehicles) out[String(v.id)] = c.expected[String(v.id)] ?? null;
  return out;
}

describe('T8 leader rule: shared fixture docs/fixtures/leader_cases.json', () => {
  it('fixture is well formed and covers the required situations', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(Object.keys(c.expected).sort()).toEqual(c.vehicles.map((v) => String(v.id)).sort());
      expect(new Set(c.vehicles.map((v) => v.id)).size).toBe(c.vehicles.length);
      if (c.mode === 'lane') expect(Number.isInteger(c.lanes)).toBe(true);
    }
    expect(cases.some((c) => c.mode === 'lane')).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name} (strips from the spec formula, test helper)`, () => {
      const strips = caseStrips(c);
      const input: LeaderInput[] = c.vehicles.map((v, i) => ({
        front: v.frontM,
        length: v.lengthM,
        lo: strips[i]![0],
        hi: strips[i]![1],
      }));
      const got = findLeaders(input);
      expect(got).toBeInstanceOf(Int32Array);
      expect(got.length).toBe(c.vehicles.length);
      expect(toIds(c, got)).toEqual(expectedIds(c));
    });

    it(`${c.name} (strips from the engine's strips module)`, () => {
      const L =
        c.mode === 'lane' ? laneLayout(c.roadWidthM, c.lanes!) : stripLayout(c.roadWidthM, c.stripWidthM);
      expect(L).toEqual(caseLayout(c));
      const strips = c.vehicles.map((v) =>
        c.mode === 'lane' ? laneStrip(v.centreM, L) : occupiedStrips(v.centreM, v.widthM, v.clearanceM, L),
      );
      expect(strips).toEqual(caseStrips(c));
      const got = findLeaders(
        c.vehicles.map((v, i) => ({ front: v.frontM, length: v.lengthM, lo: strips[i]![0], hi: strips[i]![1] })),
      );
      expect(toIds(c, got)).toEqual(expectedIds(c));
    });
  }
});

describe('T8 leader rule: property against a brute-force reference', () => {
  it('empty input', () => {
    const r = findLeaders([]);
    expect(r).toBeInstanceOf(Int32Array);
    expect(r.length).toBe(0);
  });

  it('matches the literal rule on random scenes (many ties in front, rear and strips)', () => {
    const vehicle = fc
      .record({
        front: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.double({ min: -50, max: 200, noNaN: true })),
        length: fc.oneof(fc.integer({ min: 1, max: 14 }), fc.double({ min: 0.5, max: 18, noNaN: true })),
        a: fc.integer({ min: 0, max: 22 }),
        b: fc.integer({ min: 0, max: 22 }),
      })
      .map(({ front, length, a, b }) => ({ front, length, lo: Math.min(a, b), hi: Math.max(a, b) }));
    fc.assert(
      fc.property(fc.array(vehicle, { minLength: 0, maxLength: 40 }), (vs) => {
        const got = Array.from(findLeaders(vs));
        expect(got).toEqual(leadersRef(vs));
      }),
      { seed: 1114, numRuns: 1500 },
    );
  });
});

describe('T8 across the ring\'s link end (leader with small s)', () => {
  const P: Idm = { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 };
  const LEN = 5;
  const DT = 0.2;
  const L = 100;

  /**
   * From the t = 0 snapshot (all at rest, MODEL.md §1.7), every vehicle's leader on a single-file
   * ring is the next vehicle ahead in wrapped position, and its gap is
   * wrap(s_leader − s_i, L) − ℓ. For the vehicle with the largest s, that leader is across the
   * link end (smallest s) and the search must continue onto the next element of its route (the
   * same ring link via the free movement at n0), offset by the remaining length L − s_i.
   * After one step VehicleView.a is the IDM acceleration used for that step:
   * a(v = 0, gap, dv = 0) = a·(1 − (s0/gap)²) (MODEL.md §1.3).
   *
   * Tolerance 1e-9 m/s²: positions are O(100 m) with ulp ≈ 1.4e-14 m; the engine's ring length
   * (sum of 360 segment lengths) may differ from circumferenceM by ≲ 360·EPS·L ≈ 1e-11 m.
   * The acceleration's sensitivity to the gap is 2a·s0²/gap³ ≤ 0.6 s⁻² for gap ≥ 3 m, so the
   * expected rounding discrepancy is < 1e-11 m/s². Treating the wrapped leader as absent would
   * be off by a·(s0/gap)² ≥ 1e-3 m/s² (checked as a premise).
   */
  function checkWrap(densityPerKm: number, jitterM: number, seed: number) {
    const N = ringCount(densityPerKm, L);
    const sim = createSim({
      scenario: ringScenario({ circumferenceM: L, densityPerKm, jitterM, seed }),
      classes: ringClassSet(P, LEN),
    });
    expect(sim.vehicleCount()).toBe(N);
    const before = sim.vehicles();
    for (const v of before) expect(v.v).toBe(0);
    const order = before.map((v, k) => ({ k, s: wrap(v.s, L) })).sort((x, y) => x.s - y.s);
    const expectedAcc = new Map<number, number>();
    const gapOf = new Map<number, number>();
    order.forEach((o, i) => {
      const lead = order[(i + 1) % order.length]!;
      const gap = wrap(lead.s - o.s, L) - LEN;
      gapOf.set(before[o.k]!.id, gap);
      expectedAcc.set(before[o.k]!.id, idmRef(P, 0, gap, 0));
    });
    const last = order[order.length - 1]!;
    const wrapId = before[last.k]!.id;
    // premises: the last vehicle's leader is across the end and the wrapped gap matters
    expect(order[0]!.s).toBeLessThan(last.s);
    expect(gapOf.get(wrapId)!).toBeGreaterThan(P.s0);
    expect(gapOf.get(wrapId)!).toBeLessThan(150); // inside the look-ahead of §1.6
    expect(P.a - expectedAcc.get(wrapId)!).toBeGreaterThan(1e-3);

    sim.advance(1);
    const after = sim.vehicles();
    expect(after.map((v) => v.id)).toEqual(before.map((v) => v.id));
    for (let k = 0; k < after.length; k++) {
      const v = after[k]!;
      const acc = expectedAcc.get(v.id)!;
      expect(Math.abs(v.a - acc)).toBeLessThanOrEqual(1e-9);
      // ballistic from rest: v = a·dt, Δs = ½·a·dt² (MODEL.md §1.4), Δs taken modulo L
      expect(Math.abs(v.v - acc * DT)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(wrap(v.s - before[k]!.s, L) - 0.5 * acc * DT * DT)).toBeLessThanOrEqual(1e-9);
    }
  }

  it('two vehicles at rest (each one\'s leader is the other; one across the end)', () => {
    checkWrap(20, 3, 5); // N = round(20·100/1000) = 2, gaps ≈ 45 m ± 6 m
  });

  it('ten vehicles at rest with jitter (gaps 3–7 m)', () => {
    checkWrap(100, 1, 6); // N = 10, spacing 10 m, ℓ = 5 m, jitter ±1 m
  });
});
