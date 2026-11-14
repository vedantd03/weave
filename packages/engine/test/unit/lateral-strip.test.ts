/**
 * Strip-mode lateral model (docs/MODEL.md §2.4): candidate set and J, edge clearance, lateral
 * speed, swept occupancy while moving, and the deterministic commit order.
 *
 * Scenes are built with addVehicle on a corridor with change 'none' (no route bias). Positions
 * are chosen so every body+clearance edge sits mid-strip (helpers/m2-scenes.ts yForLo), so the
 * strip spans are robust to rounding, and every decision has a margin ≥ 0.1 m/s² in Δ. The
 * expected decision for every vehicle comes from the §2.4 reference (helpers/mobil-ref.ts),
 * and each test also states the hand-derived outcome.
 */
import { describe, expect, it } from 'vitest';
import type { ClassSpec } from '../helpers/m2.ts';
import { buildScene, yForLo, type Scene, type SceneVehicle } from '../helpers/m2-scenes.ts';
import { idmRef } from '../helpers/idm-theory.ts';
import { layoutRef, occupiedRef } from '../helpers/strips-ref.ts';

const IDM = { v0: 20, T: 1.5, s0: 2, a: 1.5, b: 2 };
const CLASSES: ClassSpec[] = [
  // J = max(1, floor(maxLat·τ/w)) with τ = 1 s, w = 7/23 = 0.3043 m: car → floor(2.63) = 2
  { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0.8, politeness: 0, threshold: 0.1 },
  // auto: maxLat 1.0 → J = floor(3.29) = 3
  { id: 'auto', length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 1.0, politeness: 0, threshold: 0.1 },
  { id: 'motorcycle', length: 2, width: 0.8, idm: IDM, c0: 0.15, c1: 0, maxLat: 0.8, politeness: 0, threshold: 0.1 },
];
const H_CAR = 0.9 + 0.2; // body half-width + clearance
const W7 = 7;
const w7 = layoutRef(7, 0.3).w; // 7/23

function scene(vehicles: SceneVehicle[], W = W7): Scene {
  const s = buildScene({ W, lanes: 2, mode: 'strip', classes: CLASSES, vehicles });
  s.sim.advance(1);
  return s;
}
function expectMatchesReference(s: Scene) {
  s.refVehicles.forEach((rv, k) => {
    const v = s.view(k);
    expect(Math.abs(v.a - s.ref.acc.get(rv.id)!)).toBeLessThanOrEqual(1e-9);
    expect(v.targetY).toBeCloseTo(s.ref.target.get(rv.id)!, 9);
  });
}
/** Subject (strips lo..lo+7) behind a slow motorcycle overlapping its k rightmost strips. */
function blockedScene(cls: 'car' | 'auto', lo: number, k: number, v = 10, mcFront = 520, mcV = 2): SceneVehicle[] {
  const hi = lo + 7;
  return [
    { cls, front: 500, y: yForLo(lo, 1.8, 0.2, w7), v },
    { cls: 'motorcycle', front: mcFront, y: yForLo(hi - (k - 1), 0.8, 0.15, w7), v: mcV },
  ];
}

describe('strip-mode candidates and J', () => {
  it('premise: the subject spans 8 strips, the motorcycle overlaps exactly k of them', () => {
    const L = layoutRef(7, 0.3);
    expect(L.n).toBe(23);
    const [S, M] = blockedScene('car', 6, 2);
    expect(occupiedRef(S!.y, 1.8, 0.2, L)).toEqual([6, 13]);
    expect(occupiedRef(M!.y, 0.8, 0.15, L)).toEqual([12, 16]);
  });

  it('J = 2: escape needs a 2-strip move → moves left by exactly 2 strips (smallest escaping |j|)', () => {
    const s = scene(blockedScene('car', 6, 2));
    const c = s.ref.candidates.get(0)!;
    expect(c.map((x) => x.j)).toEqual([-2, -1, 1, 2]); // the candidate set {±1, ±2}
    expect(c.find((x) => x.j === -2)!.delta).toBeGreaterThan(1);
    expect(c.find((x) => x.j === -1)!.delta).toBe(0); // still behind the motorcycle
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(s.refVehicles[0]!.y - 2 * w7, 9);
  });

  it('J = 2 cannot escape a 3-strip overlap → stays; J = 3 (maxLat 1.0) escapes with j = −3', () => {
    const car = scene(blockedScene('car', 6, 3));
    expect(car.ref.candidates.get(0)!.every((x) => !(x.delta > 0.1))).toBe(true);
    expectMatchesReference(car);
    expect(car.view(0).targetY).toBeCloseTo(car.refVehicles[0]!.y, 9);

    const auto = scene(blockedScene('auto', 6, 3));
    expect(auto.ref.candidates.get(0)!.map((x) => x.j)).toEqual([-3, -2, -1, 1, 2, 3]);
    expectMatchesReference(auto);
    expect(auto.view(0).targetY).toBeCloseTo(auto.refVehicles[0]!.y - 3 * w7, 9);
  });

  it('edge clearance: a candidate needs y′ − h ≥ 0, so the escape is impossible one strip closer to the kerb', () => {
    // lo = 1: y − 2w − h = −0.5w < 0 → j = −2 is not a candidate → stays.
    const near = scene(blockedScene('car', 1, 2));
    expect(near.ref.candidates.get(0)!.map((x) => x.j)).toEqual([-1, 1, 2]);
    expect(near.refVehicles[0]!.y - 2 * w7 - H_CAR).toBeLessThan(0);
    expectMatchesReference(near);
    expect(near.view(0).targetY).toBeCloseTo(near.refVehicles[0]!.y, 9);
    // lo = 2: y − 2w − h = +0.5w ≥ 0 → escapes.
    const ok = scene(blockedScene('car', 2, 2));
    expect(ok.refVehicles[0]!.y - 2 * w7 - H_CAR).toBeGreaterThan(0);
    expectMatchesReference(ok);
    expect(ok.view(0).targetY).toBeCloseTo(ok.refVehicles[0]!.y - 2 * w7, 9);
  });
});

describe('strip-mode lateral speed and swept occupancy', () => {
  it('v ≥ 3 m/s: full lateral speed, Δy = maxLat·dt = 0.16 m; occupancy = sweptStrips(y, targetY)', () => {
    const s = scene(blockedScene('car', 6, 2));
    const v = s.view(0);
    // speed before (10) and after (10 + a·dt ≥ 10 − 9·0.2 = 8.2) are both ≥ 3 → factor 1
    expect(v.v).toBeGreaterThanOrEqual(3);
    const y0 = s.refVehicles[0]!.y;
    expect(v.y).toBeCloseTo(y0 - 0.8 * 0.2, 9);
    const L = layoutRef(7, 0.3);
    const a = occupiedRef(v.y, 1.8, 0.2, L);
    const b = occupiedRef(v.targetY, 1.8, 0.2, L);
    expect([v.lo, v.hi]).toEqual([Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
    expect([v.lo, v.hi]).toEqual([4, 13]);
  });

  it('standstill: v_lat = 25% of maxLat → Δy = 0.25·0.8·0.2 = 0.04 m', () => {
    // Stopped car 1.5 m (< s0) behind a stopped motorcycle: a = a(1 − (s0/1.5)²) < 0 at v = 0,
    // so the stop branch keeps v = 0 before and after the step (no ambiguity about which v).
    const s = scene([
      { cls: 'car', front: 500, y: yForLo(6, 1.8, 0.2, w7), v: 0 },
      { cls: 'motorcycle', front: 503.5, y: yForLo(12, 0.8, 0.15, w7), v: 0 },
    ]);
    expectMatchesReference(s);
    const v = s.view(0);
    expect(Math.abs(v.v)).toBe(0);
    expect(v.targetY).toBeCloseTo(s.refVehicles[0]!.y - 2 * w7, 9);
    expect(v.y).toBeCloseTo(s.refVehicles[0]!.y - 0.25 * 0.8 * 0.2, 9);
  });

  it('a vehicle behind, overlapping only the swept strips, follows the mover in the next step', () => {
    // F (motorcycle, strips 0..4) is not behind S's original span 6..13 but is inside S's swept
    // span 4..13 once S starts moving left. Step 2's acceleration of F must be the IDM value
    // with S as leader (from the post-step-1 state).
    const vs = [...blockedScene('car', 6, 2), { cls: 'motorcycle' as const, front: 470, y: yForLo(0, 0.8, 0.15, w7), v: 10 }];
    const s = scene(vs);
    expectMatchesReference(s); // F stays (no incentive), S moves
    const S1 = s.view(0);
    const F1 = s.view(2);
    expect([F1.lo, F1.hi]).toEqual([0, 4]);
    expect(S1.lo).toBeLessThanOrEqual(F1.hi);
    s.sim.advance(1);
    const F2 = s.view(2);
    const gap = S1.s - S1.length - F1.s;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(150);
    expect(Math.abs(F2.a - idmRef(IDM, F1.v, gap, F1.v - S1.v))).toBeLessThanOrEqual(1e-9);
    // and it is genuinely slower than free road (S is a real obstacle for F)
    expect(F2.a).toBeLessThan(idmRef(IDM, F1.v, Infinity, 0) - 1e-3);
  });
});

describe('strip-mode commit order', () => {
  // W = 8.5 m → n = round(28.33) = 28 strips, w = 8.5/28. A (strips 4..11) and B (13..20) are
  // side by side with ONE empty strip (12) between them. Each has a slow motorcycle overlapping
  // only its outer edge, so each escapes by moving one strip into strip 12. Individually both
  // decisions are safe (neither target overlaps the other's current span), but the swept spans
  // A 4..12 and B 12..20 overlap and the vehicles are side by side, so the second one in the
  // order (front desc, id asc) is dropped.
  const w85 = layoutRef(8.5, 0.3).w;
  const sceneAB = (frontA: number, frontB: number) =>
    scene(
      [
        { cls: 'car', front: frontA, y: yForLo(4, 1.8, 0.2, w85), v: 10 },
        { cls: 'car', front: frontB, y: yForLo(13, 1.8, 0.2, w85), v: 10 },
        { cls: 'motorcycle', front: 520, y: yForLo(0, 0.8, 0.15, w85), v: 2 },
        { cls: 'motorcycle', front: 520, y: yForLo(20, 0.8, 0.15, w85), v: 2 },
      ],
      8.5,
    );

  it('A ahead (front 500 vs 498): A commits, B is dropped', () => {
    const s = sceneAB(500, 498);
    expect(s.ref.decision.get(0)).not.toBeNull(); // both decided …
    expect(s.ref.decision.get(1)).not.toBeNull();
    expectMatchesReference(s); // … but only A was committed
    expect(s.view(0).targetY).toBeCloseTo(s.refVehicles[0]!.y + w85, 9);
    expect(s.view(1).targetY).toBeCloseTo(s.refVehicles[1]!.y, 9);
  });

  it('B ahead (front 500 vs 498): B commits, A is dropped', () => {
    const s = sceneAB(498, 500);
    expect(s.ref.decision.get(0)).not.toBeNull();
    expect(s.ref.decision.get(1)).not.toBeNull();
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(s.refVehicles[0]!.y, 9);
    expect(s.view(1).targetY).toBeCloseTo(s.refVehicles[1]!.y - w85, 9);
  });
});

