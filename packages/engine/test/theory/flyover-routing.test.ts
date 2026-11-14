/**
 * Routing onto the flyover (docs/MODEL.md §2.1 route cost, §2.8 movement speed limit, §3.5).
 *
 * Cost of a route = Σ over its segments of (2-D polyline length / speed limit + penalty), with
 * penalty 15 s for a `signal` movement, 5 s for a `minor` movement, 0 otherwise; a movement's
 * speed limit is min(speedLimit(fromLink), speedLimit(toLink)). The test computes, from the
 * generated geometry, the cost of every route from arm{A}_in to arm{B}_out with a test-local
 * Dijkstra, and checks that the cheapest one is the flyover (fly{A}{B}_up → deck → down) and
 * that it beats the at-grade route (arm{A}_in_near → box m{A}_{B} → arm{B}_out_near) by at least
 * 1 s. In plan both routes measure about 2R + 2r0 + 40 m, so the margin comes from the penalties:
 * the at-grade route always pays ≥ 5 s (its exit merges as `minor` at mB) plus the box penalty.
 *
 * In the simulation (observable outputs only): with demand A → B and B → A, the decks carry
 * traffic and the at-grade box movements m{A}_{B}, m{B}_{A} carry none (linkStats). With turning
 * demand out of arm A only, the box movement carries traffic and the decks none.
 */
import { describe, expect, it } from 'vitest';
import { generateNetwork } from '../../src/index.ts';
import { GeneratorParams, Network } from '../../src/schema/index.ts';
import { classSet, linkStat, makeSim } from '../helpers/m2.ts';
import { cheapest, junctionScenario, type Arm } from '../helpers/m3.ts';

/** Cost of the best route that avoids every segment in `banned`. */
function cheapestAvoiding(net: Network, from: string, to: string, banned: Set<string>) {
  const pruned = { ...net, movements: net.movements.filter((m) => !banned.has(m.id) && !banned.has(m.toLink) && !banned.has(m.fromLink)) };
  return cheapest(pruned as Network, from, to);
}

interface Case {
  name: string;
  angles: number[];
  control: 'signal' | 'priority';
  majorArms?: [number, number];
  A: number;
  B: number;
}
const CASES: Case[] = [
  { name: '4 arms, signal, flyover 0↔2', angles: [0, 90, 180, 270], control: 'signal', A: 0, B: 2 },
  { name: '4 arms, priority (major 0–2), flyover 1↔3', angles: [0, 90, 180, 270], control: 'priority', majorArms: [0, 2], A: 1, B: 3 },
  { name: '4 arms, priority (major 0–2), flyover 0↔2', angles: [10, 95, 185, 280], control: 'priority', majorArms: [0, 2], A: 0, B: 2 },
  { name: '3 arms, signal, flyover 0↔1', angles: [0, 120, 240], control: 'signal', A: 0, B: 1 },
  { name: '5 arms, signal, flyover 0↔2', angles: [0, 72, 144, 216, 288], control: 'signal', A: 0, B: 2 },
];
const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);

for (const c of CASES) {
  describe(`flyover routing: ${c.name}`, () => {
    const arms: Arm[] = c.angles.map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
    const flyover = { enabled: true, armA: c.A, armB: c.B, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 };
    const params = { generator: 'junction', arms, control: c.control, ...(c.majorArms ? { majorArms: c.majorArms } : {}), flyover };
    const net = Network.parse(generateNetwork(GeneratorParams.parse(params)));
    const boxOf = (X: number, Y: number) =>
      net.movements.find((m) => m.fromLink.startsWith(`arm${X}_in`) && m.toLink.startsWith(`arm${Y}_out`) && !m.fromLink.startsWith('fly'))!;
    const sc = (od: { origin: string; destination: string; rateVph: number }[]) =>
      junctionScenario({ arms, control: c.control, majorArms: c.majorArms, flyover, od, seed: 23 });

    it('by the §2.1 cost rule the deck route is the cheapest, ≥ 1 s ahead of the at-grade route', () => {
      for (const [X, Y] of [
        [c.A, c.B],
        [c.B, c.A],
      ] as const) {
        const best = cheapest(net, `arm${X}_in`, `arm${Y}_out`);
        expect(best.path).toContain(`fly${X}${Y}_up`);
        expect(best.path).toContain(`fly${X}${Y}_deck`);
        expect(best.path).toContain(`fly${X}${Y}_down`);
        const box = boxOf(X, Y);
        expect(box).toBeDefined();
        const ground = cheapestAvoiding(net, `arm${X}_in`, `arm${Y}_out`, new Set([`fly${X}${Y}_up`]));
        expect(ground.path).toContain(box.id);
        expect(ground.cost - best.cost).toBeGreaterThanOrEqual(1);
      }
    });

    it('simulation: A↔B traffic uses the decks and never the at-grade box movement', () => {
      const sim = makeSim(
        sc([
          { origin: `arm${c.A}_in`, destination: `arm${c.B}_out`, rateVph: 400 },
          { origin: `arm${c.B}_in`, destination: `arm${c.A}_out`, rateVph: 400 },
        ]),
        classes,
      );
      sim.advance(3000); // 600 s
      expect(linkStat(sim, `fly${c.A}${c.B}_deck`).entered).toBeGreaterThan(0);
      expect(linkStat(sim, `fly${c.B}${c.A}_deck`).entered).toBeGreaterThan(0);
      expect(linkStat(sim, boxOf(c.A, c.B).id).entered).toBe(0);
      expect(linkStat(sim, boxOf(c.B, c.A).id).entered).toBe(0);
      expect(sim.trips().length).toBeGreaterThan(0);
    });

    it('simulation: turning traffic out of arm A uses the at-grade box, not the deck', () => {
      const T = c.angles.findIndex((_, k) => k !== c.A && k !== c.B);
      const sim = makeSim(sc([{ origin: `arm${c.A}_in`, destination: `arm${T}_out`, rateVph: 400 }]), classes);
      sim.advance(3000);
      expect(linkStat(sim, boxOf(c.A, T).id).entered).toBeGreaterThan(0);
      expect(linkStat(sim, `fly${c.A}${c.B}_deck`).entered).toBe(0);
      expect(linkStat(sim, `fly${c.B}${c.A}_deck`).entered).toBe(0);
    });
  });
}
