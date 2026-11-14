/**
 * Webster retiming (docs/MODEL.md §5.3): retimeWebster(plan, criticalFlowRatio).
 * C and the per-phase lost time (amber + all-red) are kept; G = C − Σ lost; y_p = max ratio over
 * the phase's movements (0 if none); g_p ∝ y_p with 5 s minima (phases that would fall below
 * 5 s are fixed at 5 s and the others rescaled to Σ g = G); equal split when Σ y = 0.
 * Expected greens are computed by hand (and by helpers/stats-ref.ts retimeRef for properties).
 * Tolerance 1e-9 s: a handful of floating-point operations on values ≤ 300 s.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { criticalFlowRatios, retimeWebster, retimedFlyoverScenario } from '../../src/junction/retime.ts';
import { generateNetwork } from '../../src/index.ts';
import { GeneratorParams, Network } from '../../src/schema/index.ts';
import { criticalFlowRatiosRef, junctionScenario, plan, type Plan } from '../helpers/m3.ts';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';
import { retimeRef } from '../helpers/stats-ref.ts';

const P3 = plan({
  node: 'X', offsetS: 11, amberS: 3, allRedS: 2,
  phases: [
    { greenS: 30, protected: ['a1', 'a2'] },
    { greenS: 20, protected: ['b1'] },
    { greenS: 10, protected: ['c1'] },
  ],
}); // C = 60 + 3·5 = 75, G = 60
const greens = (p: Plan) => p.phases.map((ph) => ph.greenS);
const cyc = (p: Plan) => p.phases.reduce((a, ph) => a + ph.greenS + p.amberS + p.allRedS, 0);
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(Math.abs(x - b[i]!)).toBeLessThanOrEqual(1e-9));

describe('retimeWebster', () => {
  it('green proportional to y (y_p = max over the phase); C, lost time, offset, movements kept', () => {
    // y = [max(0.2, 0.3), 0.15, 0.05] = [0.3, 0.15, 0.05], Σ = 0.5 → 60·[0.6, 0.3, 0.1] = [36, 18, 6]
    const r = retimeWebster(P3, { a1: 0.2, a2: 0.3, b1: 0.15, c1: 0.05 });
    close(greens(r), [36, 18, 6]);
    expect(cyc(r)).toBeCloseTo(75, 9);
    expect([r.node, r.offsetS, r.amberS, r.allRedS]).toEqual(['X', 11, 3, 2]);
    expect(r.phases.map((ph) => ph.protected)).toEqual(P3.phases.map((ph) => ph.protected));
  });

  it('5 s minima are kept and the rest rescaled', () => {
    // y = [0.3, 0.1, 0.01]: raw 60·[0.732, 0.244, 0.024] = [43.9, 14.6, 1.46] → c fixed at 5,
    // remaining 55 s split 3 : 1 → [41.25, 13.75, 5]
    close(greens(retimeWebster(P3, { a1: 0.3, a2: 0, b1: 0.1, c1: 0.01 })), [41.25, 13.75, 5]);
    // two phases below 5 s: [0.6, 0.04, 0.03] → [50, 5, 5]
    close(greens(retimeWebster(P3, { a1: 0.6, a2: 0, b1: 0.04, c1: 0.03 })), [50, 5, 5]);
    // a phase with no ratio at all gets the minimum
    close(greens(retimeWebster(P3, { a1: 0.3, b1: 0.3 })), [27.5, 27.5, 5]);
  });

  it('Σ y = 0 → equal split of G', () => {
    close(greens(retimeWebster(P3, {})), [20, 20, 20]);
    close(greens(retimeWebster(P3, { a1: 0, b1: 0, c1: 0 })), [20, 20, 20]);
  });

  it('property: matches the reference; Σ g = G; all g ≥ 5; proportional above the minimum', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ g: fc.integer({ min: 5, max: 60 }), y: fc.double({ min: 0, max: 0.6, noNaN: true }) }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (ph, amber, allRed) => {
          const p = plan({ node: 'X', amberS: amber, allRedS: allRed, phases: ph.map((x, i) => ({ greenS: x.g, protected: [`m${i}`] })) });
          const ratio = Object.fromEntries(ph.map((x, i) => [`m${i}`, x.y]));
          const G = cyc(p) - ph.length * (amber + allRed);
          fc.pre(G >= 5 * ph.length);
          const r = greens(retimeWebster(p, ratio));
          close(r, retimeRef(p, ratio));
          expect(Math.abs(r.reduce((a, b) => a + b, 0) - G)).toBeLessThanOrEqual(1e-9);
          for (const g of r) expect(g).toBeGreaterThanOrEqual(5 - 1e-9);
        },
      ),
      { seed: 53, numRuns: 500 },
    );
  });
});

describe('critical flow ratios on a generated flyover junction (§5.3 "Use")', () => {
  // The ratio of movement m is q_m/s_m with q_m the OD demand routed through m (§2.1 routes,
  // computed here with the test-local Dijkstra of helpers/m3.ts) and s_m = 1800 veh/h per 3.5 m
  // of movement width. With the flyover on, A↔B through demand runs on the deck, so it adds
  // nothing to the at-grade box movements: the flyover arms' phases lose the green they no
  // longer need when the plan is retimed.
  const arms = [0, 90, 180, 270].map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
  const fly = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 };
  const od: { origin: string; destination: string; rateVph: number }[] = [];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 4; k++) {
      if (i === k) continue;
      const through = Math.abs(i - k) === 2;
      od.push({ origin: `arm${i}_in`, destination: `arm${k}_out`, rateVph: through && (i % 2 === 0) ? 900 : through ? 300 : 120 });
    }
  }
  const ratios = (net: Network) => criticalFlowRatiosRef(net, od);
  const gen = (flyover?: typeof fly) =>
    Network.parse(generateNetwork(GeneratorParams.parse({ generator: 'junction', arms, control: 'signal', ...(flyover ? { flyover } : {}) })));

  it('deck through demand does not load the box; retimed greens follow; flyover arms lose green', () => {
    const on = gen(fly);
    const off = gen();
    const rOn = ratios(on);
    const rOff = ratios(off);
    const box = (n: Network, X: number, Y: number) =>
      n.movements.find((m) => m.node === n.signals[0]!.node && m.fromLink.startsWith(`arm${X}_in`) && m.toLink.startsWith(`arm${Y}_out`))!.id;
    expect(rOn[box(on, 0, 2)]).toBe(0);
    expect(rOn[box(on, 2, 0)]).toBe(0);
    expect(rOff[box(off, 0, 2)]).toBeGreaterThan(0);
    const pOn = retimeWebster(on.signals[0]!, rOn);
    const pOff = retimeWebster(off.signals[0]!, rOff);
    close(greens(pOn), retimeRef(on.signals[0]!, rOn));
    close(greens(pOff), retimeRef(off.signals[0]!, rOff));
    expect(cyc(pOn)).toBeCloseTo(cyc(on.signals[0]!), 9);
    // phases 0 and 2 serve the flyover arms
    expect(pOn.phases[0]!.greenS).toBeLessThan(pOff.phases[0]!.greenS);
    expect(pOn.phases[2]!.greenS).toBeLessThan(pOff.phases[2]!.greenS);
  });
});

describe('criticalFlowRatios(input) and retimedFlyoverScenario(input) (§5.3)', () => {
  const arms = [0, 90, 180, 270].map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
  const fly = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 };
  const od: { origin: string; destination: string; rateVph: number }[] = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) if (i !== k) od.push({ origin: `arm${i}_in`, destination: `arm${k}_out`, rateVph: 100 + 50 * i + 20 * k });
  const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);
  const junction = (flyover: boolean) => junctionScenario({ arms, od, ...(flyover ? { flyover: fly } : {}) });
  const corridor = corridorScenario({
    lengthM: 600, widthM: 7, lanes: 2, change: { kind: 'laneDrop', atM: 300, dropLanes: 1, taperM: 50 }, rateVph: 1500,
  });
  // ratios are sums of integer rates divided by 1800·w/3.5: the oracle and the engine may group
  // the division differently, so compare to 1e-12 relative
  const same = (got: Record<string, number>, ref: Record<string, number>) => {
    expect(Object.keys(got).sort()).toEqual(Object.keys(ref).sort());
    for (const [k, v] of Object.entries(ref)) expect(Math.abs(got[k]! - v), k).toBeLessThanOrEqual(1e-12 * Math.max(1, v));
  };

  for (const [name, sc] of [
    ['junction, flyover off', junction(false)],
    ['junction, flyover on', junction(true)],
    ['lane-drop corridor', corridor],
  ] as const) {
    it(`${name}: equals the oracle (§2.1 routes with penalties, q_m/s_m) for every movement`, () => {
      const net = makeSim(sc, classes).network;
      const ref = criticalFlowRatiosRef(net, sc.od ?? []);
      expect(Object.values(ref).some((v) => v > 0)).toBe(true);
      same(criticalFlowRatios({ scenario: sc, classes }), ref);
    });
  }

  it('corridor: the taper carries all the demand: ratio = 1500 / (1800·W2/3.5) with W2 = 3.5 m', () => {
    const r = criticalFlowRatios({ scenario: corridor, classes });
    expect(r.taper).toBeCloseTo(1500 / 1800, 12);
  });

  it('retimedFlyoverScenario: signalOverrides = retimeWebster(plan, ratios) for every plan; nothing else changes', () => {
    const sc = junction(true);
    const net = makeSim(sc, classes).network;
    const ref = criticalFlowRatiosRef(net, od);
    const out = retimedFlyoverScenario({ scenario: sc, classes });
    const { signalOverrides, ...rest } = out;
    const { signalOverrides: _orig, ...restIn } = sc;
    expect(rest).toEqual(restIn);
    const plans = (signalOverrides ?? []) as unknown as Plan[];
    expect(plans.map((p) => p.node)).toEqual(net.signals.map((p) => p.node));
    plans.forEach((p, i) => {
      const base = net.signals[i]!;
      expect([p.offsetS, p.amberS, p.allRedS]).toEqual([base.offsetS, base.amberS, base.allRedS]);
      expect(p.phases.map((ph) => [ph.protected, ph.permissive ?? []])).toEqual(base.phases.map((ph) => [ph.protected, ph.permissive]));
      close(greens(p), retimeRef(base, ref));
    });
    // and the flyover arms lose green relative to the generated split phasing
    expect(plans[0]!.phases[0]!.greenS).toBeLessThan(net.signals[0]!.phases[0]!.greenS);
  });
});
