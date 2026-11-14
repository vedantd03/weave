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
import { buildScene, type SceneOpts, type SceneVehicle } from '../helpers/m2-scenes.ts';
import { idmRef } from '../helpers/idm-theory.ts';
import { B_SAFE } from '../helpers/mobil-ref.ts';

const IDM = { v0: 20, T: 1.5, s0: 2, a: 1.5, b: 2 };
const base = { length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0.8 };
const CLASSES: ClassSpec[] = [
  { id: 'car', ...base, politeness: 0, threshold: 0.1 },
  { id: 'lcv', ...base, politeness: 1, threshold: 0.1 }, // fully polite
  { id: 'truck', ...base, politeness: 0, threshold: 1.0 }, // high threshold
  { id: 'auto', ...base, politeness: 0, threshold: 0.5 }, // route-bias scene
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
  s.refVehicles.forEach((rv) => {
    const v = s.view(rv.id); // ref id = placement index
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

/*
 * Amended §2.4 (ADR-014, ADR-016): mover self-safety, pairwise B_SAFE commit re-check, band
 * keeping, route bias β = min(1, 200/max(d, 1)), and followers across segment starts.
 * Same method: margins asserted as premises, every vehicle compared with the reference.
 */
describe('T10 MOBIL, amended rules (ADR-014/016)', () => {
  const laneDrop = { kind: 'laneDrop' as const, atM: 600, dropLanes: 1, taperM: 50 }; // band [0, 3.5]
  function sceneWith(o: Partial<SceneOpts> & { vehicles: SceneVehicle[] }, lanes = 2) {
    const s = buildScene({ W: 3.5 * lanes, lanes, mode: 'lane', classes: CLASSES, ...o });
    s.sim.advance(1);
    return s;
  }

  it('self-safety: Δ > threshold but ã_c < −B_SAFE behind a slower vehicle in the target lane → stay', () => {
    const s = scene([
      { cls: 'car', front: 500, y: L0, v: 20 },
      { cls: 'car', front: 515, y: L0, v: 5 }, // a_c = −9 (clamped)
      { cls: 'car', front: 545, y: L1, v: 12 }, // ã_c ≈ −5.6 behind it
    ]);
    const c = s.ref.candidates.get(0)![0]!;
    expect(c.delta).toBeGreaterThan(0.1 + 1); // the old rule would have changed …
    expect(c.aTildeC).toBeLessThan(-B_SAFE - 1); // … into a gap it cannot hold
    expect(c.selfSafe).toBe(false);
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(L0, 9);
  });

  it('pairwise B_SAFE commit re-check: two moves into the middle lane 10 m apart → the second is dropped', () => {
    const M0 = 1.75;
    const M1 = 5.25;
    const M2 = 8.75;
    const pair = (fa: number, fb: number) =>
      scene(
        [
          { cls: 'car', front: fa, y: M0, v: 15 },
          { cls: 'car', front: fa + 25, y: M0, v: 5 },
          { cls: 'car', front: fb, y: M2, v: 15 },
          { cls: 'car', front: fb + 25, y: M2, v: 5 },
        ],
        3,
      );
    // A ahead (500) of B (490): both decide; the s0-widened intervals [493.5, 502] and
    // [485.5, 490] are disjoint, so only the B_SAFE criterion can drop B:
    // gap 495.5 − 490 = 5.5 m at equal speeds 15 m/s → IDM_B ≈ −28 → −9 < −4.
    const s = pair(500, 490);
    expect(s.ref.decision.get(0)).toBe(M1);
    expect(s.ref.decision.get(2)).toBe(M1);
    expect(500 - 4.5 - 2 > 490).toBe(true);
    expect(idmRef(IDM, 15, 5.5, 0)).toBeLessThan(-B_SAFE - 1);
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(M1, 9);
    expect(s.view(2).targetY).toBeCloseTo(M2, 9);
    // mirrored: B ahead commits, A is dropped
    const r = pair(490, 500);
    expectMatchesReference(r);
    expect(r.view(0).targetY).toBeCloseTo(M0, 9);
    expect(r.view(2).targetY).toBeCloseTo(M1, 9);
    // control: 60 m apart both commit (gap 55.5 m, IDM ≥ −4)
    const far = pair(500, 440);
    expect(idmRef(IDM, 15, 55.5, 0)).toBeGreaterThan(-B_SAFE + 1);
    expectMatchesReference(far);
    expect(far.view(0).targetY).toBeCloseTo(M1, 9);
    expect(far.view(2).targetY).toBeCloseTo(M1, 9);
  });

  it('band keeping: a vehicle inside the next movement band never overtakes out of it', () => {
    // Lane drop at 600 m: band [0, 3.5] = lane 0. Same geometry as the 'clear incentive' scene,
    // which changes lanes on a corridor without a next movement.
    const s = sceneWith({
      change: laneDrop,
      vehicles: [
        { cls: 'car', front: 300, y: L0, v: 15 },
        { cls: 'car', front: 325, y: L0, v: 5 },
      ],
    });
    expect(s.road.band).toEqual([0, 3.5]);
    expect(s.ref.candidates.get(0)).toEqual([]); // lane 1 is not a candidate
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(L0, 9);
  });

  it('route bias β = min(1, 200/d): out of band 400 m before the end → bias 1.325 > Δa_th = 0.5 → move in', () => {
    // dist(5.25) = 6.15 − 3.5 = 2.65 m, dist(1.75) = 0; d = 600 − 200 = 400 → β = 0.5.
    // (The pre-ADR-016 β = 0.5·min(1, 50/d) = 0.0625 would give 0.166 < 0.5 and no move.)
    const s = sceneWith({ change: laneDrop, vehicles: [{ cls: 'auto', front: 200, y: L1, v: 15 }] });
    const c = s.ref.candidates.get(0)!.find((x) => x.y === L0)!;
    expect(c.bias).toBeCloseTo(0.5 * 2.65, 12);
    expect(0.5 * Math.min(1, 50 / 400) * 2.65).toBeLessThan(0.5);
    expectMatchesReference(s);
    expect(s.view(0).targetY).toBeCloseTo(L0, 9);
  });
  describe('followers and side clash across the segment start (§2.4 "Followers across segment starts")', () => {
    // Corridor up (400 m) → taper (movement, 50 m, bands [0, 7] → [0, 7]) → down. k is on 'down'
    // 2 m past its start, so its rear (4.5 m) reaches back 2.5 m: predecessor-segment vehicles
    // whose fronts lie within length_k + maxLength = 9 m of the start count, at position
    // s_j − length(taper) = s_j − 50. k is behind a slow leader (Δ ≈ 10); F is in lane 1 on the
    // taper (addVehicle on a movement id, §2.7); the lateral map is the identity.
    const split = { kind: 'width' as const, atM: 400, toWidthM: 7, toLanes: 2, taperM: 50 };
    const run = (F: SceneVehicle) =>
      sceneWith({
        change: split,
        vehicles: [
          { cls: 'car', front: 2, y: L0, v: 10, link: 'down' },
          { cls: 'car', front: 22, y: L0, v: 2, link: 'down' },
          F,
        ],
      });

    it('control: F far upstream on up → k changes lanes', () => {
      expect(idmRef(IDM, 10, 22 - 4.5 - 2, 8)).toBeLessThan(-8); // a_c
      const s = run({ cls: 'car', front: 200, y: L1, v: 15, link: 'up' });
      expect(s.view(0).targetY).toBeCloseTo(L1, 9);
    });

    it('F close behind on the taper is the new follower: ã_N = IDM(15, 3.5 m, +5) < −B_SAFE → stay', () => {
      // F front at 44 − 50 = −6 (within 9 m of the start); g_N = rear_k − front_F = −2.5 − (−6) = 3.5 m
      expect(idmRef(IDM, 15, 3.5, 5)).toBeLessThan(-B_SAFE - 1);
      const s = run({ cls: 'car', front: 44, y: L1, v: 15, link: 'taper' });
      expect(s.view(0).targetY).toBeCloseTo(L0, 9);
    });

    it("F alongside k's tail on the taper is a side clash → stay", () => {
      // F body [−5, −0.5] in k's coordinates overlaps k's [−2.5, 2]
      const s = run({ cls: 'car', front: 49.5, y: L1, v: 10, link: 'taper' });
      expect(s.view(0).targetY).toBeCloseTo(L0, 9);
    });
  });
});
