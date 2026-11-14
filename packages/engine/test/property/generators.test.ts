/**
 * Generator properties (docs/MODEL.md §3.1, §3.5, §3.6): for random valid junction and merge
 * parameters, the network parses, every in-zone reaches every out-zone it has a movement path
 * to (junction: all other arms; merge: main_out), conflicts are symmetric (A lists B with
 * [self, other] ⇔ B lists A with them swapped), and flyover off ⇒ no link above layer 0.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateNetwork } from '../../src/index.ts';
import { computeConflicts } from '../../src/network/conflicts.ts';
import { GeneratorParams, Network } from '../../src/schema/index.ts';
import { reachableLinks } from '../helpers/m3.ts';

const armArb = fc.record({
  inLanes: fc.integer({ min: 1, max: 3 }),
  outLanes: fc.integer({ min: 1, max: 3 }),
  // ≥ 3.5 m so a one-lane flyover arm still contains the 3.5 m ramp band [inW − rampW, inW]
  laneW: fc.double({ min: 3.5, max: 3.8, noNaN: true }),
  lengthM: fc.integer({ min: 200, max: 400 }),
});

const junctionArb = fc
  .record({
    n: fc.integer({ min: 3, max: 6 }),
    rot: fc.double({ min: 0, max: 359, noNaN: true }),
    jitter: fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: 6, maxLength: 6 }),
    arms: fc.array(armArb, { minLength: 6, maxLength: 6 }),
    control: fc.constantFrom('signal' as const, 'priority' as const),
    flyover: fc.boolean(),
    deckW: fc.double({ min: 6, max: 10, noNaN: true }),
  })
  .map((r) => {
    // angles spread evenly with jitter: separation ≥ 360/6 − 20 = 40°
    const arms = Array.from({ length: r.n }, (_, k) => {
      const a = r.arms[k]!;
      const ang = (((r.rot + (360 * k) / r.n + r.jitter[k]!) % 360) + 360) % 360;
      return {
        angleDeg: Math.min(ang, 359.999),
        inWidthM: a.inLanes * a.laneW,
        outWidthM: a.outLanes * a.laneW,
        inLanes: a.inLanes,
        outLanes: a.outLanes,
        lengthM: a.lengthM,
      };
    });
    const opposite = Math.floor(r.n / 2);
    return {
      generator: 'junction' as const,
      arms,
      control: r.control,
      ...(r.control === 'priority' ? { majorArms: [0, opposite] as [number, number] } : {}),
      ...(r.flyover
        ? { flyover: { enabled: true, armA: 0, armB: opposite, deckWidthM: r.deckW, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 } }
        : {}),
    };
  });

function checkSymmetric(net: Network) {
  const conf = computeConflicts(net);
  for (const [a, list] of conf) {
    for (const c of list) {
      const back = (conf.get(c.movement) ?? []).find((x) => x.movement === a);
      expect(back, `${a} lists ${c.movement} but not vice versa`).toBeDefined();
      expect(back!.self).toEqual(c.other);
      expect(back!.other).toEqual(c.self);
      expect(back!.type).toBe(c.type);
    }
  }
}

describe('generator properties', () => {
  it('junction: parses, connected, symmetric conflicts, flyover off ⇒ layer 0 only', () => {
    fc.assert(
      fc.property(junctionArb, (p) => {
        const net = Network.parse(generateNetwork(GeneratorParams.parse(p)));
        const ins = net.zones.filter((z) => z.role === 'in');
        const outs = net.zones.filter((z) => z.role === 'out');
        expect(ins.length).toBe(p.arms.length);
        expect(outs.length).toBe(p.arms.length);
        for (const zi of ins) {
          const reach = reachableLinks(net, zi.link);
          const k = /^arm(\d+)_in$/.exec(zi.id)![1];
          for (const zo of outs) {
            if (zo.id === `arm${k}_out`) continue; // no U-turns
            expect(reach.has(zo.link), `${zi.id} → ${zo.id}`).toBe(true);
          }
        }
        if (!('flyover' in p)) expect(net.links.every((l) => l.layer === 0)).toBe(true);
        checkSymmetric(net);
      }),
      { seed: 3131, numRuns: 25 },
    );
  });

  it('merge: parses, both inflows reach main_out, symmetric conflicts, no crossing conflict at n1', () => {
    fc.assert(
      fc.property(
        fc.record({
          mainLanes: fc.integer({ min: 1, max: 4 }),
          laneW: fc.double({ min: 3, max: 3.6, noNaN: true }),
          rampWidthM: fc.double({ min: 3, max: 6, noNaN: true }),
          taperM: fc.integer({ min: 30, max: 400 }),
          mainLengthM: fc.integer({ min: 600, max: 3000 }),
          rampLengthM: fc.integer({ min: 50, max: 1000 }),
          angleDeg: fc.double({ min: 5, max: 45, noNaN: true }),
        }),
        (r) => {
          const net = Network.parse(
            generateNetwork(
              GeneratorParams.parse({
                generator: 'merge', mainWidthM: r.mainLanes * r.laneW, mainLanes: r.mainLanes, rampWidthM: r.rampWidthM,
                taperM: r.taperM, mainLengthM: r.mainLengthM, rampLengthM: r.rampLengthM, angleDeg: r.angleDeg,
              }),
            ),
          );
          const out = net.zones.find((z) => z.id === 'main_out')!.link;
          for (const zin of ['main_in', 'ramp_in']) {
            expect(reachableLinks(net, net.zones.find((z) => z.id === zin)!.link).has(out)).toBe(true);
          }
          checkSymmetric(net);
          const conf = computeConflicts(net);
          const a = net.movements.find((m) => m.fromLink === 'main_up' && m.toLink === 'accel')!;
          const b = net.movements.find((m) => m.fromLink === 'ramp' && m.toLink === 'accel')!;
          expect((conf.get(a.id) ?? []).filter((c) => c.movement === b.id && c.type === 'crossing')).toEqual([]);
        },
      ),
      { seed: 3636, numRuns: 50 },
    );
  });
});
