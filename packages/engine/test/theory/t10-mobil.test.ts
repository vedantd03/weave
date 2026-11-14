/**
 * T10 — MOBIL in lane mode (docs/MODEL.md §2.4, "Lane mode reduces to MOBIL"; Kesting,
 * Treiber & Helbing 2007, "General lane-changing model MOBIL for car-following models",
 * Transp. Res. Rec. 1999).
 *
 * Each scene is a corridor with change 'none' (no next route element ⇒ route bias 0, no
 * threshold waiver) with vehicles placed by addVehicle. After ONE step, VehicleView.targetY
 * shows the committed decision. The expected decision for EVERY vehicle comes from the
 * test-local reference (helpers/mobil-ref.ts) written from §2.4:
 *   Δ = (ã_c − a_c) + p·((ã_N − a_N) + (ã_O − a_O)),  qualify: safe ∧ Δ > Δa_th,
 *   safe: new-leader gap > 0, g_N > 0, ã_N ≥ −B_SAFE (4 m/s²), no longitudinal clash,
 * with IDM accelerations from helpers/idm-theory.ts. Every scene also asserts its premise
 * (the margin of Δ to the threshold, of ã_N to −4), so no decision hinges on rounding:
 * all margins are ≥ 0.1 m/s², while the engine and the reference can differ only by
 * operation-order rounding (≲ 1e-13 m/s²).
 */
import { describe, expect, it } from 'vitest';
import type { ClassSpec } from '../helpers/m2.ts';
import { buildScene, type SceneVehicle } from '../helpers/m2-scenes.ts';
import { B_SAFE } from '../helpers/mobil-ref.ts';

const IDM = { v0: 20, T: 1.5, s0: 2, a: 1.5, b: 2 };
const base = { length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0.8 };
const CLASSES: ClassSpec[] = [
  { id: 'car', ...base, politeness: 0, threshold: 0.1 },
  { id: 'lcv', ...base, politeness: 1, threshold: 0.1 }, // fully polite
  { id: 'truck', ...base, politeness: 0, threshold: 1.0 }, // high threshold
];
const L0 = 1.75; // lane centres, 2 × 3.5 m
const L1 = 5.25;
const LANE_DT_SHIFT = (3.5 / 3) * 0.2; // lane-mode v_lat·dt = laneWidth/3 s · dt

function scene(vehicles: SceneVehicle[], lanes = 2) {
  const s = buildScene({ W: 3.5 * lanes, lanes, mode: 'lane', classes: CLASSES, vehicles });
  s.sim.advance(1);
  return s;
}

/** Engine targetY and a equal the reference for every vehicle in the scene. */
function expectMatchesReference(s: ReturnType<typeof scene>) {
  s.refVehicles.forEach((rv, k) => {
    const v = s.view(k);
    expect(Math.abs(v.a - s.ref.acc.get(rv.id)!)).toBeLessThanOrEqual(1e-9);
    expect(v.targetY).toBeCloseTo(s.ref.target.get(rv.id)!, 9);
  });
}

describe('T10 MOBIL, lane mode', () => {
  it('addVehicle ids are 0x50000000 + k and targetY starts at y', () => {
    const s = buildScene({
      W: 7,
      lanes: 2,
      mode: 'lane',
      classes: CLASSES,
      vehicles: [
        { cls: 'car', front: 100, y: L0, v: 10 },
        { cls: 'car', front: 300, y: L1, v: 10 },
      ],
    });
    expect(s.ids).toEqual([0x50000000, 0x50000001]);
    expect(s.view(0).targetY).toBe(L0);
    expect(s.view(1).targetY).toBe(L1);
  });

  it('clear incentive (slow leader, empty adjacent lane) → change, and the lateral move starts', () => {
    const s = scene([
      { cls: 'car', front: 500, y: L0, v: 15 },
      { cls: 'car', front: 525, y: L0, v: 5 },
    ]);
    const c = s.ref.candidates.get(0)!.find((x) => x.y === L1)!;
    expect(c.safe).toBe(true);
    expect(c.delta).toBeGreaterThan(0.1 + 1); // premise: margin ≫ rounding
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(L1, 9);
    expect(s.view(1).targetY).toBeCloseTo(L0, 9); // leader stays (p = 0, no own incentive)
    // lateral motion: y ← y + min(|Δy|, v_lat·dt), v_lat = laneWidth / 3 s
    expect(s.view(0).y).toBeCloseTo(L0 + LANE_DT_SHIFT, 9);
    // while moving it occupies both lanes
    expect([s.view(0).lo, s.view(0).hi]).toEqual([0, 1]);
  });

  it('incentive between two thresholds: car (Δa_th = 0.1) changes, truck (Δa_th = 1.0) stays', () => {
    const geometry = (cls: 'car' | 'truck'): SceneVehicle[] => [
      { cls, front: 500, y: L0, v: 15 },
      { cls: 'car', front: 560, y: L0, v: 13 },
    ];
    const car = scene(geometry('car'));
    const delta = car.ref.candidates.get(0)![0]!.delta;
    expect(delta).toBeGreaterThan(0.1 + 0.2); // premise: 0.1 + margin < Δ < 1.0 − margin
    expect(delta).toBeLessThan(1.0 - 0.2);
    expectMatchesReference(car);
    expect(car.view(0).targetY).toBeCloseTo(L1, 9);

    const truck = scene(geometry('truck'));
    expect(truck.ref.candidates.get(0)![0]!.delta).toBeCloseTo(delta, 12); // same IDM ⇒ same Δ
    expectMatchesReference(truck);
    expect(truck.view(0).targetY).toBeCloseTo(L0, 9);
  });

  it('unsafe new follower (ã_N < −B_SAFE) → stay despite a large incentive; safe follower → change', () => {
    const unsafe = scene([
      { cls: 'car', front: 500, y: L0, v: 15 },
      { cls: 'car', front: 525, y: L0, v: 5 },
      { cls: 'car', front: 494, y: L1, v: 20 }, // g_N = 495.5 − 494 = 1.5 m
    ]);
    const cu = unsafe.ref.candidates.get(0)![0]!;
    expect(cu.delta).toBeGreaterThan(1);
    expect(cu.aTildeN!).toBeLessThan(-B_SAFE - 1);
    expectMatchesReference(unsafe);
    expect(unsafe.view(0).targetY).toBeCloseTo(L0, 9);

    const safe = scene([
      { cls: 'car', front: 500, y: L0, v: 15 },
      { cls: 'car', front: 525, y: L0, v: 5 },
      { cls: 'car', front: 440, y: L1, v: 15 }, // g_N = 55.5 m
    ]);
    const cs = safe.ref.candidates.get(0)![0]!;
    expect(cs.aTildeN!).toBeGreaterThan(-B_SAFE + 1);
    expectMatchesReference(safe);
    expect(safe.view(0).targetY).toBeCloseTo(L1, 9);
  });

  it('politeness flips the decision: p = 0 changes, p = 1 stays (cost imposed on the new follower)', () => {
    const geometry = (cls: 'car' | 'lcv'): SceneVehicle[] => [
      { cls, front: 500, y: L0, v: 15 },
      { cls: 'car', front: 545, y: L0, v: 12 },
      { cls: 'car', front: 440, y: L1, v: 20 },
    ];
    const selfish = scene(geometry('car'));
    const cs = selfish.ref.candidates.get(0)![0]!;
    expect(cs.safe).toBe(true);
    expect(cs.aTildeN!).toBeGreaterThan(-B_SAFE + 1); // the change is safe …
    expect(cs.delta).toBeGreaterThan(0.1 + 0.5); // … and worth it for a selfish driver
    expectMatchesReference(selfish);
    expect(selfish.view(0).targetY).toBeCloseTo(L1, 9);

    const polite = scene(geometry('lcv'));
    const cp = polite.ref.candidates.get(0)![0]!;
    expect(cp.delta).toBeLessThan(0.1 - 0.5); // ã_N − a_N ≈ −1.8 outweighs the own gain
    expectMatchesReference(polite);
    expect(polite.view(0).targetY).toBeCloseTo(L0, 9);
  });

  it('both sides available: the larger Δ wins (right, then mirrored left); exact tie → smaller y′', () => {
    const M0 = 1.75;
    const M1 = 5.25;
    const M2 = 8.75;
    const right = scene(
      [
        { cls: 'car', front: 500, y: M1, v: 15 },
        { cls: 'car', front: 520, y: M1, v: 5 },
        { cls: 'car', front: 560, y: M0, v: 10 },
        { cls: 'car', front: 600, y: M2, v: 10 }, // farther leader on the right
      ],
      3,
    );
    const [dl, dr] = [M0, M2].map((y) => right.ref.candidates.get(0)!.find((c) => c.y === y)!.delta);
    expect(dr! - dl!).toBeGreaterThan(0.5);
    expectMatchesReference(right);
    expect(right.view(0).targetY).toBeCloseTo(M2, 9);

    const left = scene(
      [
        { cls: 'car', front: 500, y: M1, v: 15 },
        { cls: 'car', front: 520, y: M1, v: 5 },
        { cls: 'car', front: 600, y: M0, v: 10 },
        { cls: 'car', front: 560, y: M2, v: 10 },
      ],
      3,
    );
    expectMatchesReference(left);
    expect(left.view(0).targetY).toBeCloseTo(M0, 9);

    // both side lanes empty: identical computations give an exact tie → smaller y′ (§2.4)
    const tie = scene(
      [
        { cls: 'car', front: 500, y: M1, v: 15 },
        { cls: 'car', front: 520, y: M1, v: 5 },
      ],
      3,
    );
    const ds = tie.ref.candidates.get(0)!.map((c) => c.delta);
    expect(ds[0]).toBe(ds[1]);
    expect(tie.view(0).targetY).toBeCloseTo(M0, 9);
  });

  it('no candidate outside the road: a vehicle in the leftmost lane only considers the right', () => {
    const s = scene([
      { cls: 'car', front: 500, y: L0, v: 15 },
      { cls: 'car', front: 525, y: L0, v: 5 },
    ]);
    expect(s.ref.candidates.get(0)!.map((c) => c.y)).toEqual([L1]);
    expectMatchesReference(s);
  });
});
