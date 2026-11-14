/**
 * Test-local reference of the lateral decision rule of docs/MODEL.md §2.4 (generalised MOBIL,
 * as amended by ADR-014/016) for vehicles on ONE link. Optionally the link's next route element
 * is a movement with band [b0, b1] (`road.band`, with `road.linkLength` giving d = L − front):
 * then the lane-band obstacle (§2.2), band keeping, route bias β = min(1, 200/max(d, 1)) and the
 * 30 m threshold waiver apply. Without `band` all of those are inactive (bias = 0, dist = 0).
 * Includes mover self-safety (ã_c ≥ −B_SAFE) and the pairwise B_SAFE commit re-check.
 * Written from the spec text; the engine's code is never consulted.
 */
import { idmRef, type Idm } from './idm-theory.ts';
import { laneRef, layoutRef, occupiedRef, type Layout } from './strips-ref.ts';
import type { ClassParams } from './m2.ts';

export const B_SAFE = 4;

export interface RefVehicle {
  id: number;
  front: number;
  y: number;
  v: number;
  cls: ClassParams;
}

export interface RefRoad {
  W: number;
  mode: 'strip' | 'lane';
  stripW: number;
  lanes: number;
  speedLimit: number;
  /** fromLateral band of the next movement, if the link has one */
  band?: [number, number];
  /** link length (needed with `band`) */
  linkLength?: number;
}

export interface CandidateInfo {
  j: number;
  y: number;
  safe: boolean;
  delta: number;
  aTildeC: number;
  aTildeN: number | null;
  gN: number | null;
  newLeaderGap: number | null;
  longitudinalClash: boolean;
  selfSafe: boolean;
  bias: number;
}

export interface RefResult {
  /** current IDM acceleration a_x of every vehicle (step 1 of §2.5) */
  acc: Map<number, number>;
  /** decision before commit (null = stay) */
  decision: Map<number, number | null>;
  /** target after the commit re-check (= y when not changing) */
  target: Map<number, number>;
  candidates: Map<number, CandidateInfo[]>;
}

export function roadLayout(r: RefRoad): Layout {
  return r.mode === 'strip' ? layoutRef(r.W, r.stripW) : layoutRef(r.W, r.W / r.lanes);
}

const eff = (r: RefRoad, c: ClassParams): Idm => ({ ...c.idm, v0: Math.min(c.idm.v0, r.speedLimit) });
const clr = (veh: RefVehicle) => veh.cls.c0 + veh.cls.c1 * veh.v;

export function spanAt(r: RefRoad, L: Layout, veh: RefVehicle, y: number): [number, number] {
  return r.mode === 'strip' ? occupiedRef(y, veh.cls.width, clr(veh), L) : laneRef(y, L);
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

export function referenceDecisions(vs: readonly RefVehicle[], r: RefRoad): RefResult {
  const L = roadLayout(r);
  const span = vs.map((x) => spanAt(r, L, x, x.y));
  const rear = (k: number) => vs[k]!.front - vs[k]!.cls.length;

  const OBSTACLE = -2;
  /** body distance outside the next movement's band (0 without a band) */
  function dist(veh: RefVehicle, y: number): number {
    if (!r.band) return 0;
    return Math.max(0, r.band[0] - (y - veh.cls.width / 2)) + Math.max(0, y + veh.cls.width / 2 - r.band[1]);
  }
  /** §1.6 leader over a span, with look-ahead cap D and the lane-band obstacle at body position y. */
  function leader(i: number, sp: [number, number], exclude: number, y = vs[i]!.y): { k: number; gap: number } {
    let best = -1;
    let bestRear = Infinity;
    if (r.band && dist(vs[i]!, y) > 0) {
      best = OBSTACLE;
      bestRear = r.linkLength!;
    }
    for (let j = 0; j < vs.length; j++) {
      if (j === i || j === exclude) continue;
      if (!overlaps(span[j]!, sp)) continue;
      const ahead = vs[j]!.front > vs[i]!.front || (vs[j]!.front === vs[i]!.front && j > i);
      if (!ahead) continue;
      if (rear(j) < bestRear) {
        bestRear = rear(j);
        best = j;
      }
    }
    if (best === -1) return { k: -1, gap: Infinity };
    const gap = bestRear - vs[i]!.front;
    const me = vs[i]!;
    const D = Math.max(150, (me.v * me.v) / (2 * me.cls.idm.b) + 50);
    if (gap > D) return { k: -1, gap: Infinity };
    return { k: best, gap };
  }
  function accWith(i: number, ld: { k: number; gap: number }): number {
    const me = vs[i]!;
    if (ld.k === -1) return idmRef(eff(r, me.cls), me.v, Infinity, 0);
    const vL = ld.k === OBSTACLE ? 0 : vs[ld.k]!.v;
    return idmRef(eff(r, me.cls), me.v, ld.gap, me.v - vL);
  }
  function follower(i: number, sp: [number, number]): number {
    let best = -1;
    for (let j = 0; j < vs.length; j++) {
      if (j === i || !overlaps(span[j]!, sp)) continue;
      const behind = vs[j]!.front < vs[i]!.front || (vs[j]!.front === vs[i]!.front && vs[j]!.id < vs[i]!.id);
      if (!behind) continue;
      if (
        best < 0 ||
        vs[j]!.front > vs[best]!.front ||
        (vs[j]!.front === vs[best]!.front && vs[j]!.id > vs[best]!.id)
      )
        best = j;
    }
    return best;
  }

  const acc = vs.map((_, i) => accWith(i, leader(i, span[i]!, -1)));
  const result: RefResult = { acc: new Map(), decision: new Map(), target: new Map(), candidates: new Map() };
  vs.forEach((x, i) => result.acc.set(x.id, acc[i]!));

  const decided: { i: number; y: number; swept: [number, number] }[] = [];
  for (let i = 0; i < vs.length; i++) {
    const me = vs[i]!;
    const h = me.cls.width / 2 + clr(me);
    const ys: { j: number; y: number }[] = [];
    if (r.mode === 'strip') {
      const J = Math.max(1, Math.floor((me.cls.maxLat * 1) / L.w));
      for (let j = -J; j <= J; j++) {
        if (j === 0) continue;
        const y = me.y + j * L.w;
        if (y - h >= 0 && y + h <= r.W) ys.push({ j, y });
      }
    } else {
      const lw = r.W / r.lanes;
      for (const j of [-1, 1]) {
        const y = me.y + j * lw;
        if (y > 0 && y < r.W) ys.push({ j, y });
      }
    }
    const O = follower(i, span[i]!);
    const infos: CandidateInfo[] = [];
    const d = r.band ? r.linkLength! - me.front : Infinity;
    const beta = Math.min(1, 200 / Math.max(d, 1));
    const dist0 = dist(me, me.y);
    for (const c of ys) {
      // band keeping: never leave the band of the next movement when inside it
      if (dist0 === 0 && dist(me, c.y) > 0) continue;
      const spT = spanAt(r, L, me, c.y);
      const spS: [number, number] = [Math.min(spT[0], span[i]![0]), Math.max(spT[1], span[i]![1])];
      // new leader (span_t), ahead of i, lane-band obstacle evaluated at y'
      const nl = leader(i, spT, -1, c.y);
      const aTildeC = accWith(i, nl);
      const selfSafe = aTildeC >= -B_SAFE;
      let safe = (nl.k === -1 || nl.gap > 0) && selfSafe;
      // new follower N
      const N = follower(i, spT);
      let aTildeN: number | null = null;
      let gN: number | null = null;
      let termN = 0;
      if (N >= 0) {
        const n = vs[N]!;
        gN = me.front - me.cls.length - n.front;
        aTildeN = idmRef(eff(r, n.cls), n.v, gN, n.v - me.v);
        if (!(gN > 0) || aTildeN < -B_SAFE) safe = false;
        termN = aTildeN - acc[N]!;
      }
      // longitudinal clash with anything overlapping the swept span
      let clash = false;
      for (let j = 0; j < vs.length; j++) {
        if (j === i || !overlaps(span[j]!, spS)) continue;
        if (rear(j) < me.front && vs[j]!.front > me.front - me.cls.length) clash = true;
      }
      if (clash) safe = false;
      let termO = 0;
      if (O >= 0) termO = accWith(O, leader(O, span[O]!, i)) - acc[O]!;
      const bias = r.band ? beta * (dist0 - dist(me, c.y)) : 0;
      const delta = aTildeC - acc[i]! + me.cls.p * (termN + termO) + bias;
      infos.push({
        j: c.j, y: c.y, safe, delta, aTildeC, aTildeN, gN,
        newLeaderGap: nl.k === -1 ? null : nl.gap, longitudinalClash: clash, selfSafe, bias,
      });
    }
    result.candidates.set(me.id, infos);
    let best: CandidateInfo | null = null;
    const th = dist0 > 0 && d < 30 ? 0 : me.cls.th; // waiver
    for (const c of infos) {
      if (!c.safe || !(c.delta > th)) continue;
      if (
        !best ||
        c.delta > best.delta ||
        (c.delta === best.delta && (Math.abs(c.j) < Math.abs(best.j) || (Math.abs(c.j) === Math.abs(best.j) && c.y < best.y)))
      )
        best = c;
    }
    result.decision.set(me.id, best ? best.y : null);
    if (best) {
      const spT = spanAt(r, L, me, best.y);
      decided.push({ i, y: best.y, swept: [Math.min(spT[0], span[i]![0]), Math.max(spT[1], span[i]![1])] });
    }
  }
  // commit in (front desc, id asc)
  decided.sort((A, B) => vs[B.i]!.front - vs[A.i]!.front || vs[A.i]!.id - vs[B.i]!.id);
  const committed: typeof decided = [];
  for (const d of decided) {
    const me = vs[d.i]!;
    const s0 = me.cls.idm.s0;
    const conflict = committed.some((k) => {
      if (!overlaps(k.swept, d.swept)) return false;
      const o = vs[k.i]!;
      const lo = o.front - o.cls.length - s0;
      const hi = o.front + s0;
      if (lo <= me.front && me.front - me.cls.length <= hi) return true;
      // pairwise B_SAFE criteria (ADR-014); "ahead" by (front, id)
      const oAhead = o.front > me.front || (o.front === me.front && o.id > me.id);
      const [lead, foll] = oAhead ? [o, me] : [me, o];
      const gap = lead.front - lead.cls.length - foll.front;
      if (!(gap > 0)) return true;
      return idmRef(eff(r, foll.cls), foll.v, gap, foll.v - lead.v) < -B_SAFE;
    });
    if (!conflict) committed.push(d);
  }
  for (const x of vs) result.target.set(x.id, x.y);
  for (const d of committed) result.target.set(vs[d.i]!.id, d.y);
  return result;
}
