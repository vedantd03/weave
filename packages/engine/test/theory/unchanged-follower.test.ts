/**
 * §2.4 "Unchanged follower": when the new follower N in the target strips is the vehicle that
 * already follows the mover in its current span (N = O), the move leaves N's leader and gap
 * unchanged, so N's gap floor and B_SAFE checks are skipped (and both politeness terms are 0).
 *
 * Scene (merge generator, §3.6): the acceleration lane 'accel' is 10.5 m wide and its movement to
 * main_down has band [3.5, 10.5]. A car (width 2.19 m) centred at y = 3.99 m (body [2.895, 5.085],
 * 0.605 m left of the band) is stopped at the lane-band obstacle with gap s0 to the end; a
 * motorcycle (width 0.6 m, y = 4.88 m) is stopped 0.05 m behind the car's rear, overlapping the
 * car's current span and every target span to the right. Without the rule N's gap 0.05 m is
 * below the kinematic floor max(v·dt + …, ½·s0) ≥ 0.1 m and the car could never move (the merge
 * deadlock that motivated the rule).
 *
 * Lane mode is not tested here: adjacent lanes never overlap, so N ≠ O there, and T10 checks
 * every lane-mode decision against a reference without the exemption.
 *
 * Time bound. The car needs y ≥ 3.5 + 2.19/2 = 4.595, a displacement of 0.605 m, made in moves of
 * whole strips: at most ceil(0.605/Δ)·Δ. At a standstill the lateral speed is
 * maxLat·min(1, 0.25 + 0/4) = 0.25·maxLat (§2.4, snapshot speed). Each decision can cost one
 * extra step, and there are at most ceil(0.605/Δ) of them. Once inside the band the end is no
 * longer an obstacle; from rest the free IDM acceleration is ≥ a/2 for v ≤ 0.84·v0, so the
 * s0 = 2 m to the end take ≤ √(2·2/(a/2)) s. Plus 2 steps for detection.
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioInput } from '../../src/schema/index.ts';
import { classSet, makeSim, type ClassSpec } from '../helpers/m2.ts';
import { layoutRef, occupiedRef } from '../helpers/strips-ref.ts';
import { collisions, plen } from '../helpers/m3.ts';

const DT = 0.2;
const DELTA = 0.25;
const CAR: ClassSpec = { id: 'car', length: 4.5, width: 2.19, idm: { v0: 12, T: 1.2, s0: 2, a: 1.5, b: 2 }, c0: 0.2, c1: 0, maxLat: 0.8, politeness: 0.2, threshold: 0.1 };
const MOTO: ClassSpec = { id: 'motorcycle', length: 2, width: 0.6, idm: { v0: 13, T: 1, s0: 1.5, a: 2, b: 2.5 }, c0: 0.15, c1: 0, maxLat: 0.8, politeness: 0.2, threshold: 0.1 };

const scenario: ScenarioInput = {
  version: 1, id: 'merge-follower', name: 'merge follower',
  network: {
    kind: 'generator',
    params: { generator: 'merge', mainWidthM: 7, mainLanes: 2, rampWidthM: 3.5, taperM: 150, mainLengthM: 600, rampLengthM: 200, angleDeg: 15 },
  },
  od: [], composition: { car: 1 }, mode: 'strip', stripWidthM: DELTA, durationS: 3600, warmupS: 0, seed: 1,
};

describe('§2.4 unchanged follower (N = O)', () => {
  it('a car stopped out of band with a motorcycle 0.05 m behind still edges into the band and enters the movement', () => {
    const sim = makeSim(scenario, classSet([CAR, MOTO]));
    const net = sim.network;
    const accel = net.links.find((l) => l.id === 'accel')!;
    const mv = net.movements.find((m) => m.fromLink === 'accel')!;
    const band = mv.fromLateral;
    expect(band).toEqual([3.5, 10.5]);
    const L = plen(accel.polyline);
    const yCar = 3.99;
    const yMoto = 4.88;
    const carFront = L - CAR.idm.s0; // gap s0 to the obstacle: a(1 − (s0/s0)²) = 0 at rest
    const motoFront = carFront - CAR.length - 0.05;

    // premises: N = O (the motorcycle overlaps the current span and every target span to the
    // right within J = floor(0.8/0.25) = 3 strips), and its gap is below the kinematic floor
    const lay = layoutRef(accel.widthM, DELTA);
    const moto = occupiedRef(yMoto, MOTO.width, MOTO.c0!, lay);
    const ov = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
    for (let j = 0; j <= 3; j++) expect(ov(occupiedRef(yCar + j * DELTA, CAR.width, CAR.c0!, lay), moto)).toBe(true);
    expect(0.05).toBeLessThan(Math.max(0.1, 0.5 * MOTO.idm.s0));
    expect(yCar - CAR.width / 2).toBeLessThan(band[0]);

    const carId = sim.addVehicle({ classId: 'car', link: 'accel', s: carFront, y: yCar, v: 0 });
    sim.addVehicle({ classId: 'motorcycle', link: 'accel', s: motoFront, y: yMoto, v: 0 });

    const need = band[0] + CAR.width / 2 - yCar; // 0.605 m
    const strips = Math.ceil(need / DELTA);
    const tBound = (strips * DELTA) / (0.25 * CAR.maxLat!) + strips * DT + Math.sqrt((2 * CAR.idm.s0) / (CAR.idm.a / 2)) + 2 * DT;
    let tInBand = -1;
    let tEntered = -1;
    for (let k = 1; k <= Math.ceil(tBound / DT) + 5; k++) {
      sim.advance(1);
      expect(collisions(sim.vehicles())).toEqual([]);
      const car = sim.vehicles().find((v) => v.id === carId);
      if (!car) break;
      if (tInBand < 0 && car.y - car.width / 2 >= band[0] - 1e-9) tInBand = sim.t;
      if (tEntered < 0 && car.link !== 'accel') tEntered = sim.t;
      if (tEntered >= 0) break;
    }
    expect(tInBand).toBeGreaterThan(0);
    expect(tEntered).toBeGreaterThan(0);
    expect(tEntered).toBeLessThanOrEqual(tBound + 1e-9);
  });
});
