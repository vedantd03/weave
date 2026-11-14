/**
 * Constructed one-link scenes for the lateral-decision tests: a corridor with change 'none'
 * (so there is no next route element: route bias 0, no lane-band obstacle, no waiver) and
 * vehicles placed with sim.addVehicle (MODEL.md §2.7: class base parameters, targetY = y).
 */
import type { VehicleClassId } from '../../src/schema/index.ts';
import { classParams, classSet, corridorScenario, makeSim, type Change, type ClassSpec, type M2Sim, type VView } from './m2.ts';
import { referenceDecisions, type RefResult, type RefRoad, type RefVehicle } from './mobil-ref.ts';

export interface SceneVehicle {
  cls: VehicleClassId;
  front: number;
  y: number;
  v: number;
  /** segment to place the vehicle on (default: 'main', or 'up' when the corridor has a change) */
  link?: string;
}

export interface SceneOpts {
  W: number;
  lanes: number;
  mode: 'strip' | 'lane';
  classes: ClassSpec[];
  vehicles: SceneVehicle[];
  lengthM?: number;
  /** corridor change; with one, the reference is given the taper band and the 'up' length */
  change?: Change;
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
  const change = o.change ?? { kind: 'none' as const };
  const sim = makeSim(
    corridorScenario({ lengthM: o.lengthM ?? 2000, widthM: o.W, lanes: o.lanes, mode: o.mode, speedLimitMps: SPEED_LIMIT, change }),
    classSet(o.classes),
  );
  const home = change.kind === 'none' ? 'main' : 'up';
  const ids = o.vehicles.map((v) => sim.addVehicle({ classId: v.cls, link: v.link ?? home, s: v.front, y: v.y, v: v.v }));
  const spec = new Map(o.classes.map((c) => [c.id, classParams(c)]));
  // the reference covers the vehicles on the home link only
  const onHome = o.vehicles.filter((v) => (v.link ?? home) === home);
  const refVehicles: RefVehicle[] = onHome.map((v) => ({
    id: o.vehicles.indexOf(v), front: v.front, y: v.y, v: v.v, cls: spec.get(v.cls)!,
  }));
  const road: RefRoad = { W: o.W, mode: o.mode, stripW: 0.3, lanes: o.lanes, speedLimit: SPEED_LIMIT };
  if (change.kind !== 'none') {
    const taper = sim.network.movements.find((m) => m.fromLink === 'up')!;
    road.band = [taper.fromLateral[0], taper.fromLateral[1]];
    road.linkLength = change.atM;
  }
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
