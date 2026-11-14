/**
 * Property: no collisions (M2 acceptance). For random valid corridor scenarios (width, lanes,
 * change, demand, lateral mode, seed) and short runs, at every step:
 *   - no two vehicles on the same segment with overlapping strip spans [lo, hi] have
 *     overlapping longitudinal intervals (s − length, s) (touching is allowed);
 *   - every speed is ≥ 0.
 * Runtime is kept modest: 10 scenarios × 300 steps (60 s).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classSet, corridorScenario, makeSim, type Change, type ClassSpec, type VView } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };
const CLASSES = classSet([
  { id: 'car', length: 4.5, width: 1.75, idm: IDM, c0: 0.25 },
  { id: 'motorcycle', length: 2, width: 0.8, idm: { ...IDM, v0: 16, T: 0.9, s0: 1 }, c0: 0.15 },
  { id: 'auto', length: 3, width: 1.4, idm: { ...IDM, v0: 12 }, c0: 0.2 },
  { id: 'bus', length: 11, width: 2.5, idm: { ...IDM, v0: 12, T: 1.8, a: 1 }, c0: 0.3 },
] as ClassSpec[]);

function collisions(vs: readonly VView[]): string[] {
  const out: string[] = [];
  const byLink = new Map<string, VView[]>();
  for (const v of vs) byLink.set(v.link, [...(byLink.get(v.link) ?? []), v]);
  for (const [link, list] of byLink) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.lo > b.hi || b.lo > a.hi) continue;
        const overlap = Math.min(a.s, b.s) - Math.max(a.s - a.length, b.s - b.length);
        if (overlap > 1e-9) out.push(`${link}: ${a.id} [${a.lo},${a.hi}] s=${a.s} & ${b.id} [${b.lo},${b.hi}] s=${b.s}`);
      }
    }
  }
  return out;
}

const scenarioArb = fc
  .record({
    lengthM: fc.integer({ min: 300, max: 600 }),
    lanes: fc.integer({ min: 1, max: 3 }),
    laneW: fc.double({ min: 2.8, max: 3.8, noNaN: true }),
    kind: fc.constantFrom('none', 'width', 'laneDrop'),
    atFrac: fc.double({ min: 0.3, max: 0.6, noNaN: true }),
    taperM: fc.integer({ min: 0, max: 80 }),
    toLanes: fc.integer({ min: 1, max: 3 }),
    rateVph: fc.integer({ min: 300, max: 3000 }),
    mode: fc.constantFrom('strip' as const, 'lane' as const),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  })
  .map((r) => {
    const widthM = r.lanes * r.laneW;
    const atM = Math.round(r.atFrac * r.lengthM);
    let change: Change = { kind: 'none' };
    if (r.kind === 'laneDrop' && r.lanes >= 2) change = { kind: 'laneDrop', atM, dropLanes: r.lanes - 1, taperM: r.taperM };
    if (r.kind === 'width') change = { kind: 'width', atM, toWidthM: r.toLanes * r.laneW, toLanes: r.toLanes, taperM: r.taperM };
    return { ...r, widthM, change };
  });

describe('property: no collisions on random corridors', () => {
  it('no overlapping vehicles and no negative speeds at any step', () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const sim = makeSim(
          corridorScenario({
            lengthM: sc.lengthM,
            widthM: sc.widthM,
            lanes: sc.lanes,
            change: sc.change,
            rateVph: sc.rateVph,
            mode: sc.mode,
            composition: { car: 0.4, motorcycle: 0.4, auto: 0.15, bus: 0.05 },
            seed: sc.seed,
          }),
          CLASSES,
        );
        for (let k = 0; k < 300; k++) {
          sim.advance(1);
          const vs = sim.vehicles();
          expect(collisions(vs)).toEqual([]);
          for (const v of vs) expect(v.v).toBeGreaterThanOrEqual(0);
        }
      }),
      { seed: 424242, numRuns: 10 },
    );
  });
});
