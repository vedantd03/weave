/**
 * T22 — conflict-area geometry (docs/MODEL.md §3.1).
 *
 * Two straight movements through the node X at the origin: m1 along +x (width w1) and m2 at
 * angle θ (width w2), both 60 m long and centred on the origin (crossing at arc length 30 on
 * both). The cross-section of m1 at x = s − 30 is {(x, y): |y| ≤ w1/2}; it meets
 * ribbon(m2) = {|−x sinθ + y cosθ| ≤ w2/2} iff |x| sinθ ≤ w2/2 + (w1/2)|cosθ|, so the interval
 * on m1 is 30 ± (w2/sinθ + w1|cotθ|)/2, and symmetrically 30 ± (w1/sinθ + w2|cotθ|)/2 on m2.
 * Tolerance per endpoint (§3.1): 0.25 m sampling + w·|cotθ|/8 for the 9-point cross-section,
 * with w = max(w1, w2).
 */
import { describe, expect, it } from 'vitest';
import { computeConflicts } from '../../src/network/conflicts.ts';
import { Network } from '../../src/schema/index.ts';

type P = [number, number];
const W1 = 3.5;
const W2 = 5;

function net(o: { theta: number; m2Node?: string; offset?: number; same?: 'to' | 'from'; preset?: boolean }): Network {
  const th = (o.theta * Math.PI) / 180;
  const u: P = [Math.cos(th), Math.sin(th)];
  const off = o.offset ?? 0; // lateral offset of m2 (for disjoint ribbons)
  const nrm: P = [-u[1], u[0]];
  const p0: P = [-30 * u[0] + off * nrm[0], -30 * u[1] + off * nrm[1]];
  const p1: P = [30 * u[0] + off * nrm[0], 30 * u[1] + off * nrm[1]];
  const node2 = o.m2Node ?? 'X';
  const link = (id: string, from: string, to: string, pl: P[], w: number) => ({ id, from, to, polyline: pl, widthM: w, lanes: 1, speedLimitMps: 10 });
  const mv = (id: string, node: string, fromLink: string, toLink: string, path: P[], w: number) => ({
    id, node, fromLink, toLink, path, widthM: w, fromLateral: [0, w] as P, toLateral: [0, w] as P, control: 'free' as const,
  });
  const m2From = o.same === 'from' ? 'a' : 'c';
  const m2To = o.same === 'to' ? 'b' : 'd';
  return Network.parse({
    version: 1,
    id: 't22',
    name: 't22',
    nodes: [
      { id: 'X', x: 0, y: 0, kind: 'plain' },
      { id: 'Y', x: 0, y: 0, kind: 'plain' },
      { id: 'A', x: -100, y: 0, kind: 'boundary' },
      { id: 'B', x: 100, y: 0, kind: 'boundary' },
      { id: 'C', x: -100, y: -100, kind: 'boundary' },
      { id: 'D', x: 100, y: 100, kind: 'boundary' },
    ],
    links: [
      link('a', 'A', 'X', [[-100, 0], [-30, 0]], W1),
      link('b', 'X', 'B', [[30, 0], [100, 0]], W1),
      link('c', 'C', node2, [[-100, -100], p0], W2),
      link('d', node2, 'D', [p1, [100, 100]], W2),
    ],
    movements: [
      {
        ...mv('m1', 'X', 'a', 'b', [[-30, 0], [30, 0]], W1),
        ...(o.preset ? { conflicts: [{ movement: 'm2', type: 'crossing', self: [1, 2] as P, other: [3, 4] as P }] } : {}),
      },
      mv('m2', node2, node2 === 'Y' ? 'c' : m2From, m2To, [p0, p1], W2),
    ],
  });
}

const tolFor = (thetaDeg: number) => 0.25 + (Math.max(W1, W2) * Math.abs(1 / Math.tan((thetaDeg * Math.PI) / 180))) / 8;

describe('T22 conflict geometry', () => {
  for (const theta of [90, 60, 45, 30, 135]) {
    it(`two straight ribbons crossing at ${theta}°: intervals w₂/sinθ + w₁|cotθ| (and symmetric), centred on the crossing`, () => {
      const th = (theta * Math.PI) / 180;
      const len1 = W2 / Math.sin(th) + W1 * Math.abs(1 / Math.tan(th));
      const len2 = W1 / Math.sin(th) + W2 * Math.abs(1 / Math.tan(th));
      const tol = tolFor(theta);
      const conf = computeConflicts(net({ theta }));
      const c1 = (conf.get('m1') ?? []).find((c) => c.movement === 'm2')!;
      const c2 = (conf.get('m2') ?? []).find((c) => c.movement === 'm1')!;
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      expect(c1.type).toBe('crossing');
      expect(Math.abs(c1.self[0] - (30 - len1 / 2))).toBeLessThanOrEqual(tol);
      expect(Math.abs(c1.self[1] - (30 + len1 / 2))).toBeLessThanOrEqual(tol);
      expect(Math.abs(c1.other[0] - (30 - len2 / 2))).toBeLessThanOrEqual(tol);
      expect(Math.abs(c1.other[1] - (30 + len2 / 2))).toBeLessThanOrEqual(tol);
      // symmetric listing on m2 with self/other swapped
      expect(c2.self).toEqual(c1.other);
      expect(c2.other).toEqual(c1.self);
    });
  }

  it('θ = 90° reduces to w₂ on m1 and w₁ on m2', () => {
    const c1 = computeConflicts(net({ theta: 90 })).get('m1')!.find((c) => c.movement === 'm2')!;
    expect(Math.abs(c1.self[1] - c1.self[0] - W2)).toBeLessThanOrEqual(2 * 0.25);
    expect(Math.abs(c1.other[1] - c1.other[0] - W1)).toBeLessThanOrEqual(2 * 0.25);
  });

  it('types: same toLink → merging; same fromLink → diverging', () => {
    const merge = computeConflicts(net({ theta: 45, same: 'to' })).get('m1')!.find((c) => c.movement === 'm2')!;
    expect(merge.type).toBe('merging');
    const diverge = computeConflicts(net({ theta: 45, same: 'from' })).get('m1')!.find((c) => c.movement === 'm2')!;
    expect(diverge.type).toBe('diverging');
  });

  it('disjoint ribbons give no conflict', () => {
    // parallel, centrelines 10 m apart > (w1 + w2)/2 + sampling
    const conf = computeConflicts(net({ theta: 0, offset: 10 }));
    expect((conf.get('m1') ?? []).filter((c) => c.movement === 'm2')).toEqual([]);
  });

  it('movements at different nodes never conflict, even when their ribbons overlap', () => {
    const conf = computeConflicts(net({ theta: 90, m2Node: 'Y' }));
    expect((conf.get('m1') ?? []).filter((c) => c.movement === 'm2')).toEqual([]);
    expect((conf.get('m2') ?? []).filter((c) => c.movement === 'm1')).toEqual([]);
  });

  it('a movement that already carries conflicts keeps them', () => {
    const conf = computeConflicts(net({ theta: 90, preset: true }));
    expect(conf.get('m1')).toEqual([{ movement: 'm2', type: 'crossing', self: [1, 2], other: [3, 4] }]);
  });
});
