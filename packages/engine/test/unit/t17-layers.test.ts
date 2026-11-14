/**
 * T17 — layer separation (docs/MODEL.md §3.1, §3.5): conflicts exist only between movements at
 * the same node, so a flyover never conflicts with the at-grade junction below it, although
 * the deck passes over the box in plan view (premise checked geometrically).
 */
import { describe, expect, it } from 'vitest';
import { generateNetwork } from '../../src/index.ts';
import { computeConflicts } from '../../src/network/conflicts.ts';
import { GeneratorParams } from '../../src/schema/index.ts';
import { distToPolyline } from '../helpers/m3.ts';

describe('T17 flyover deck vs junction below', () => {
  const arms = [0, 90, 180, 270].map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
  const net = generateNetwork(
    GeneratorParams.parse({
      generator: 'junction', arms, control: 'signal',
      flyover: { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 },
    }),
  );
  const conf = computeConflicts(net);
  const nodeOf = new Map(net.movements.map((m) => [m.id, m.node]));
  const layerOf = new Map(net.nodes.map((n) => [n.id, n.layer]));

  it('premise: the deck overlaps at-grade box movements in plan view', () => {
    const deck = net.links.find((l) => l.id === 'fly02_deck')!;
    const centre = net.signals[0]!.node;
    const overlapping = net.movements.filter(
      (m) => m.node === centre && m.path.some((p) => distToPolyline(p, deck.polyline) < (deck.widthM + m.widthM) / 2),
    );
    expect(overlapping.length).toBeGreaterThan(0);
  });

  it('every conflict pairs movements at the same node; none crosses layers', () => {
    let total = 0;
    for (const [id, list] of conf) {
      for (const c of list) {
        total++;
        expect(nodeOf.get(c.movement), `${id} vs ${c.movement}`).toBe(nodeOf.get(id));
        expect(layerOf.get(nodeOf.get(c.movement)!)).toBe(layerOf.get(nodeOf.get(id)!));
      }
    }
    expect(total).toBeGreaterThan(0); // the at-grade box does have conflicts
    const deckMovements = net.movements.filter((m) => /^fly/.test(m.fromLink) || /^fly/.test(m.toLink)).map((m) => m.id);
    const centre = net.signals[0]!.node;
    for (const m of net.movements.filter((x) => x.node === centre)) {
      for (const c of conf.get(m.id) ?? []) expect(deckMovements).not.toContain(c.movement);
    }
  });
});
