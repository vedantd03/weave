/**
 * Constructed one-link scenes for the lateral-decision tests: a corridor with change 'none'
 * (so there is no next route element: route bias 0, no lane-band obstacle, no waiver) and
 * vehicles placed with sim.addVehicle (MODEL.md §2.7: class base parameters, targetY = y).
 */
import type { VehicleClassId } from '../../src/schema/index.ts';
import { classParams, classSet, corridorScenario, makeSim, type ClassSpec, type M2Sim, type VView } from './m2.ts';
import { referenceDecisions, type RefResult, type RefRoad, type RefVehicle } from './mobil-ref.ts';

export interface SceneVehicle {
  cls: VehicleClassId;
  front: number;
  y: number;
  v: number;
}

export interface SceneOpts {
  W: number;
  lanes: number;
  mode: 'strip' | 'lane';
  classes: ClassSpec[];
  vehicles: SceneVehicle[];
  lengthM?: number;
}

export interface Scene {
  sim: M2Sim;
  road: RefRoad;
  ref: RefResult;
  refVehicles: RefVehicle[];
  /** engine id of the k-th placed vehicle */
  ids: number[];
  view(k: number): VView;
}

export const SPEED_LIMIT = 40;

export function buildScene(o: SceneOpts): Scene {
  const sim = makeSim(
    corridorScenario({ lengthM: o.lengthM ?? 2000, widthM: o.W, lanes: o.lanes, mode: o.mode, speedLimitMps: SPEED_LIMIT }),
    classSet(o.classes),
  );
  const ids = o.vehicles.map((v) => sim.addVehicle({ classId: v.cls, link: 'main', s: v.front, y: v.y, v: v.v }));
  const spec = new Map(o.classes.map((c) => [c.id, classParams(c)]));
  const refVehicles: RefVehicle[] = o.vehicles.map((v, k) => ({ id: k, front: v.front, y: v.y, v: v.v, cls: spec.get(v.cls)! }));
  const road: RefRoad = { W: o.W, mode: o.mode, stripW: 0.3, lanes: o.lanes, speedLimit: SPEED_LIMIT };
  const ref = referenceDecisions(refVehicles, road);
  return {
    sim,
    road,
    ref,
    refVehicles,
    ids,
    view(k: number) {
      const v = sim.vehicles().find((x) => x.id === ids[k]);
      if (!v) throw new Error(`vehicle ${k} (id ${ids[k]}) not found`);
      return v;
    },
  };
}

/** y of a vehicle whose occupied span starts at strip `lo`, its left edge mid-strip. */
export function yForLo(lo: number, width: number, clearance: number, w: number): number {
  return (lo + 0.5) * w + width / 2 + clearance;
}
