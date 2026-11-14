/**
 * Corridor generator (docs/MODEL.md §2.6), part of T23, plus a property over random valid
 * parameters. The network is taken from createSim(...).network (the generated network).
 *
 * Geometry per §2.6: the corridor runs along +x, the kerb (left edge) is straight at world
 * y = 0, so a link of width W has its centreline at y = −W/2. With a change:
 * up on x ∈ [0, atM] (W, lanes), movement 'taper' on x ∈ [atM, atM + taperM] (width W2,
 * centreline −W2/2, bands [0, min(W, W2)]), down on x ∈ [atM + taperM, L] (W2, lanes2).
 * Lane drop: W2 = W·(lanes − drop)/lanes, lanes2 = lanes − drop. Width: W2 = toWidthM,
 * lanes2 = toLanes. Zones: in/out on main, or in on up and out on down.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Network } from '../../src/schema/index.ts';
import { classSet, corridorScenario, makeSim, polyLength, type Change } from '../helpers/m2.ts';

const CLASSES = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 } }]);
const net = (lengthM: number, widthM: number, lanes: number, change: Change, speedLimitMps = 16.7) =>
  makeSim(corridorScenario({ lengthM, widthM, lanes, change, speedLimitMps }), CLASSES).network;
const E = 1e-9;

function expectStraight(pl: readonly (readonly number[])[], x0: number, x1: number, y: number) {
  expect(pl[0]![0]).toBeCloseTo(x0, 9);
  expect(pl[pl.length - 1]![0]).toBeCloseTo(x1, 9);
  for (const p of pl) expect(Math.abs(p[1]! - y)).toBeLessThan(E);
  expect(polyLength(pl as number[][])).toBeCloseTo(x1 - x0, 9);
}

describe('corridor generator geometry (§2.6)', () => {
  it("change 'none': one link 'main' from (0, −W/2) to (L, −W/2); zones in/out on main", () => {
    const n = net(800, 7, 2, { kind: 'none' });
    expect(Network.safeParse(n).success).toBe(true);
    expect(n.links.map((l) => l.id)).toEqual(['main']);
    const main = n.links[0]!;
    expectStraight(main.polyline, 0, 800, -3.5);
    expect([main.widthM, main.lanes, main.speedLimitMps]).toEqual([7, 2, 16.7]);
    expect(n.zones.map((z) => [z.id, z.link, z.role]).sort()).toEqual([
      ['in', 'main', 'in'],
      ['out', 'main', 'out'],
    ]);
  });

  it('lane drop 3 → 2 at 300 m with a 60 m taper', () => {
    const n = net(900, 10.5, 3, { kind: 'laneDrop', atM: 300, dropLanes: 1, taperM: 60 });
    expect(Network.safeParse(n).success).toBe(true);
    const up = n.links.find((l) => l.id === 'up')!;
    const down = n.links.find((l) => l.id === 'down')!;
    const W2 = (10.5 * (3 - 1)) / 3; // 7
    expectStraight(up.polyline, 0, 300, -10.5 / 2);
    expectStraight(down.polyline, 360, 900, -W2 / 2);
    expect([up.widthM, up.lanes]).toEqual([10.5, 3]);
    expect(down.widthM).toBeCloseTo(W2, 12);
    expect(down.lanes).toBe(2);
    const taper = n.movements.find((m) => m.id === 'taper')!;
    expect([taper.node, taper.fromLink, taper.toLink]).toEqual(['n1', 'up', 'down']);
    expectStraight(taper.path, 300, 360, -W2 / 2);
    expect(taper.widthM).toBeCloseTo(W2, 12);
    expect(taper.fromLateral[0]).toBe(0);
    expect(taper.fromLateral[1]).toBeCloseTo(Math.min(10.5, W2), 12);
    expect(taper.toLateral[0]).toBe(0);
    expect(taper.toLateral[1]).toBeCloseTo(Math.min(10.5, W2), 12);
    // kerb at y = 0: centreline + width/2 = 0 for both links
    expect(up.polyline[0]![1] + up.widthM / 2).toBeCloseTo(0, 9);
    expect(down.polyline[0]![1] + down.widthM / 2).toBeCloseTo(0, 9);
    expect(n.zones.find((z) => z.id === 'in')!.link).toBe('up');
    expect(n.zones.find((z) => z.id === 'out')!.link).toBe('down');
  });

  it('width change 7 m/2 lanes → 10 m/3 lanes (widening): band is [0, min(W, W2)] = [0, 7]', () => {
    const n = net(1000, 7, 2, { kind: 'width', atM: 500, toWidthM: 10, toLanes: 3, taperM: 30 });
    const down = n.links.find((l) => l.id === 'down')!;
    expectStraight(down.polyline, 530, 1000, -5);
    expect([down.widthM, down.lanes]).toEqual([10, 3]);
    const taper = n.movements.find((m) => m.id === 'taper')!;
    expect(taper.fromLateral).toEqual([0, 7]);
    expect(taper.toLateral).toEqual([0, 7]);
    expect(taper.widthM).toBe(10);
    expectStraight(taper.path, 500, 530, -5);
  });

  it('the schema rejects atM + taperM ≥ lengthM and dropping every lane', () => {
    expect(() => net(500, 7, 2, { kind: 'laneDrop', atM: 480, dropLanes: 1, taperM: 20 })).toThrow();
    expect(() => net(500, 7, 2, { kind: 'laneDrop', atM: 200, dropLanes: 2, taperM: 20 })).toThrow();
  });
});

describe('corridor generator property', () => {
  const arb = fc
    .record({
      lengthM: fc.integer({ min: 100, max: 5000 }),
      lanes: fc.integer({ min: 1, max: 6 }),
      laneW: fc.double({ min: 2.5, max: 4, noNaN: true }),
      kind: fc.constantFrom('none', 'width', 'laneDrop'),
      atFrac: fc.double({ min: 0, max: 0.9, noNaN: true }),
      taperFrac: fc.double({ min: 0, max: 0.99, noNaN: true }),
      toLanes: fc.integer({ min: 1, max: 6 }),
      toLaneW: fc.double({ min: 2.5, max: 4, noNaN: true }),
      drop: fc.integer({ min: 1, max: 5 }),
    })
    .map((r) => {
      const widthM = Math.min(25, r.lanes * r.laneW);
      const atM = Math.floor(r.atFrac * r.lengthM);
      const taperM = Math.min(200, Math.floor(r.taperFrac * (r.lengthM - atM - 1)));
      let change: Change = { kind: 'none' };
      if (r.kind === 'width') change = { kind: 'width', atM, toWidthM: Math.max(2, Math.min(25, r.toLanes * r.toLaneW)), toLanes: r.toLanes, taperM };
      if (r.kind === 'laneDrop' && r.lanes >= 2) change = { kind: 'laneDrop', atM, dropLanes: Math.min(r.drop, r.lanes - 1), taperM };
      return { lengthM: r.lengthM, widthM, lanes: r.lanes, change };
    });

  it('valid parameters ⇒ a schema-valid, connected network with the kerb at y = 0 and total length L', () => {
    fc.assert(
      fc.property(arb, (p) => {
        const n = net(p.lengthM, p.widthM, p.lanes, p.change);
        expect(Network.safeParse(n).success).toBe(true);
        const links = new Map(n.links.map((l) => [l.id, l]));
        const zin = n.zones.find((z) => z.id === 'in' && z.role === 'in')!;
        const zout = n.zones.find((z) => z.id === 'out' && z.role === 'out')!;
        expect(links.has(zin.link)).toBe(true);
        expect(links.has(zout.link)).toBe(true);
        // connected: follow movements from the in-link to the out-link, summing lengths
        let cur = zin.link;
        let total = polyLength(links.get(cur)!.polyline);
        for (let hops = 0; cur !== zout.link && hops < 10; hops++) {
          const m = n.movements.find((x) => x.fromLink === cur)!;
          expect(m).toBeDefined();
          total += polyLength(m.path);
          cur = m.toLink;
          total += polyLength(links.get(cur)!.polyline);
        }
        expect(cur).toBe(zout.link);
        expect(Math.abs(total - p.lengthM)).toBeLessThan(1e-6);
        for (const l of n.links) for (const q of l.polyline) expect(Math.abs(q[1] + l.widthM / 2)).toBeLessThan(1e-9);
      }),
      { seed: 2323, numRuns: 300 },
    );
  });
});
