/**
 * T13 — signal timing (docs/MODEL.md §3.2): SIG codes, cycleLength, signalState timeline with
 * offset, amber, all-red, continuity of movements green in consecutive phases, permissive
 * phases, and scenario.signalOverrides in the simulation.
 *
 * Plan used below (amber 3 s, all-red 2 s, offset 7 s), C = 20+15+10 + 3·(3+2) = 60 s:
 *   phase 0: green 20, protected {a, b}, permissive {p}
 *   phase 1: green 15, protected {b, c}, permissive {a}
 *   phase 2: green 10, protected {d}
 * Hand-derived timeline in τ = (t − 7) mod 60 (§3.2: amber/all-red apply to movements protected
 * or permissive in phase i; continuity if protected or permissive in phase i+1):
 *   [0,20)  a G, b G, p P              [20,23) a G (permissive next), b G (protected next), p A
 *   [23,25) a G, b G, p R
 *   [25,40) a P, b G, c G              [40,43) a A, b A, c A      [43,45) a R, b R, c R
 *   [45,55) d G                        [55,58) d A               [58,60) d R
 */
import { describe, expect, it } from 'vitest';
import { SIG, cycleLength, signalState } from '../../src/junction/signals.ts';
import { ARM, SIG_SPEC, armLinks, cycleRef, junctionScenario, plan, sigRef } from '../helpers/m3.ts';
import { classSet, makeSim } from '../helpers/m2.ts';

const P = plan({
  node: 'X',
  offsetS: 7,
  amberS: 3,
  allRedS: 2,
  phases: [
    { greenS: 20, protected: ['a', 'b'], permissive: ['p'] },
    { greenS: 15, protected: ['b', 'c'], permissive: ['a'] },
    { greenS: 10, protected: ['d'] },
  ],
});
const { RED: R, AMBER: A, GREEN: G, PERMISSIVE: PM } = SIG_SPEC;

describe('T13 signals', () => {
  it('SIG codes', () => {
    expect(SIG).toEqual({ RED: 0, AMBER: 1, GREEN: 2, PERMISSIVE: 3, NONE: 255 });
  });

  it('cycleLength = Σ (green + amber + all-red), with schema defaults 3/2', () => {
    expect(cycleLength(P)).toBe(60);
    const q = plan({ node: 'X', phases: [{ greenS: 30, protected: [] }, { greenS: 12.5, protected: [] }] });
    expect(cycleLength(q)).toBe(30 + 12.5 + 2 * 5);
    expect(cycleRef(q)).toBe(52.5);
  });

  it('hand-derived colours at mid-window and boundary instants (offset 7 s)', () => {
    const at = (tau: number) => tau + 7;
    const table: [number, Record<string, number>][] = [
      [0, { a: G, b: G, p: PM, c: R, d: R }],
      [10, { a: G, b: G, p: PM, c: R, d: R }],
      [20, { a: G, b: G, p: A, c: R, d: R }],
      [21.5, { a: G, b: G, p: A, c: R, d: R }],
      [23, { a: G, b: G, p: R, c: R, d: R }],
      [24, { a: G, b: G, p: R, c: R, d: R }],
      [25, { a: PM, b: G, p: R, c: G, d: R }],
      [39.75, { a: PM, b: G, c: G, d: R }],
      [40, { a: A, b: A, c: A, d: R }],
      [43, { a: R, b: R, c: R, d: R }],
      [45, { b: R, c: R, d: G }],
      [55, { d: A }],
      [58, { d: R, a: R }],
      [59.75, { d: R, a: R, b: R }],
      [60, { a: G, b: G, p: PM }], // next cycle
    ];
    for (const [tau, exp] of table) {
      for (const [id, s] of Object.entries(exp)) expect(signalState(P, id, at(tau)), `${id} @ τ=${tau}`).toBe(s);
    }
    // negative times and other cycles: periodic in t with period C
    expect(signalState(P, 'b', 7 - 60 + 41)).toBe(A);
    expect(signalState(P, 'd', 7 - 120 + 50)).toBe(G);
    // a movement not in the plan is RED
    expect(signalState(P, 'zzz', 30)).toBe(R);
  });

  it('matches the §3.2 reference on a 0.25 s grid over 4 cycles (incl. t < 0)', () => {
    for (let k = -480; k <= 480; k++) {
      const t = k * 0.25;
      for (const id of ['a', 'b', 'c', 'd', 'p', 'zzz']) expect(signalState(P, id, t)).toBe(sigRef(P, id, t));
    }
  });

  it('protected in two consecutive phases is GREEN through the inter-green (continuity)', () => {
    for (let tau = 0; tau < 40; tau += 0.25) expect(signalState(P, 'b', tau + 7)).toBe(G);
  });
});

describe('T13 signalOverrides in the simulation', () => {
  // 4-arm signalised junction, one lane per arm. The override plan for the centre node never
  // gives arm 1's movements a phase, so no vehicle from arm 1 may ever enter a movement.
  const arms = [ARM(0), ARM(90), ARM(180), ARM(270)];
  const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);

  function run(override: boolean) {
    const base = makeSim(junctionScenario({ arms }), classes);
    const net = base.network;
    const links = armLinks(net);
    const node = net.signals[0]!.node;
    const from = (k: number) => net.movements.filter((m) => m.fromLink === links.get(k)!.inLink).map((m) => m.id);
    const order = [...links.keys()].sort((x, y) => x - y);
    const arm1 = order[1]!;
    const od = [{ origin: `arm${arm1}_in`, destination: `arm${order[3]!}_out`, rateVph: 600 }];
    const overrides = override
      ? [{ node, phases: order.filter((k) => k !== arm1).map((k) => ({ greenS: 20, protected: from(k) })) }]
      : [];
    const sim = makeSim(junctionScenario({ arms, od, signalOverrides: overrides }), classes);
    const arm1Movements = new Set(from(arm1));
    let seenOnMovement = 0;
    for (let k = 0; k < 3000; k++) {
      sim.advance(1);
      for (const v of sim.vehicles()) if (arm1Movements.has(v.link)) seenOnMovement++;
    }
    return { seenOnMovement, exited: sim.counters().exited, generated: sim.counters().generated };
  }

  it('control (generated split phasing): arm 1 traffic crosses the junction', () => {
    const r = run(false);
    expect(r.seenOnMovement).toBeGreaterThan(0);
    expect(r.exited).toBeGreaterThan(0);
  });

  it('override without a phase for arm 1: nobody from arm 1 ever enters a movement', () => {
    const r = run(true);
    expect(r.generated).toBeGreaterThan(0);
    expect(r.seenOnMovement).toBe(0);
    expect(r.exited).toBe(0);
  });
});
