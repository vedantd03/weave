import { dcos, dsin, DPI } from '../../core/dmath.ts';
import type { Link, Movement, MovementControl, Network, Node, SignalPlan, Zone } from '../../schema/network.ts';
import type { JunctionParams } from '../../schema/scenario.ts';

/**
 * N-arm junction generator, left-hand traffic, with an optional flyover (docs/MODEL.md §3.5).
 * Geometry uses dcos/dsin and arithmetic only, so it is identical in every JS engine.
 */

type V = [number, number];
const add = (a: V, b: V, k = 1): V => [a[0] + k * b[0], a[1] + k * b[1]];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k];
const dist = (a: V, b: V) => Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));
const COS30 = Math.sqrt(3) / 2;

function unit(deg: number): { e: V; n: V } {
  const th = (deg * DPI) / 180;
  const c = dcos(th);
  const s = dsin(th);
  return { e: [c, s], n: [-s, c] };
}

function bezier(P0: V, P1: V, P2: V, P3: V): V[] {
  const out: V[] = [];
  for (let j = 0; j <= 16; j++) {
    const t = j / 16;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    out.push([
      b0 * P0[0] + b1 * P1[0] + b2 * P2[0] + b3 * P3[0],
      b0 * P0[1] + b1 * P1[1] + b2 * P2[1] + b3 * P3[1],
    ]);
  }
  return out;
}

type Turn = 'through' | 'left' | 'right';

/** Turn from heading −e_i to e_k: |δ| < 30° through; δ > 0 (counter-clockwise) left. */
function turnOf(ei: V, ek: V): Turn {
  const h: V = [-ei[0], -ei[1]];
  const dot = h[0] * ek[0] + h[1] * ek[1];
  const cross = h[0] * ek[1] - h[1] * ek[0];
  if (dot > COS30) return 'through';
  return cross > 0 ? 'left' : 'right';
}

interface ArmGeo {
  e: V;
  n: V;
  inLink: string;
  inW: number;
  inLanes: number;
  outLink: string;
  outW: number;
}

export function junction(p: JunctionParams): Network {
  const arms = p.arms;
  const N = arms.length;
  const r0 = 0.5 * Math.max(...arms.map((a) => a.inWidthM + a.outWidthM)) + 4;
  const fly = p.flyover?.enabled ? p.flyover : null;
  const flyArms = new Set(fly ? [fly.armA, fly.armB] : []);
  const signal = p.control === 'signal';
  const nodes: Node[] = [{ id: 'J', x: 0, y: 0, kind: signal ? 'signal' : 'priority', layer: 0 }];
  const links: Link[] = [];
  const movements: Movement[] = [];
  const zones: Zone[] = [];
  const geo: ArmGeo[] = [];
  const sl = p.speedLimitMps;

  const link = (id: string, from: string, to: string, a: V, b: V, widthM: number, lanes: number, extra: Partial<Link> = {}) =>
    links.push({ id, from, to, polyline: [a, b], widthM, lanes, speedLimitMps: sl, layer: 0, zFromM: 0, zToM: 0, ...extra });

  arms.forEach((arm, k) => {
    const { e, n } = unit(arm.angleDeg);
    const L = arm.lengthM;
    const inStart = add(scale(e, r0 + L), n, -arm.inWidthM / 2);
    const inEnd = add(scale(e, r0), n, -arm.inWidthM / 2);
    const outStart = add(scale(e, r0), n, arm.outWidthM / 2);
    const outEnd = add(scale(e, r0 + L), n, arm.outWidthM / 2);
    nodes.push({ id: `a${k}s`, x: inStart[0], y: inStart[1], kind: 'boundary', layer: 0 });
    nodes.push({ id: `a${k}e`, x: outEnd[0], y: outEnd[1], kind: 'boundary', layer: 0 });
    if (fly && flyArms.has(k)) {
      const dS = r0 + fly.rampLengthM + 20;
      const off = fly.deckWidthM + fly.landingWidthM / 2;
      const laneW = arm.inWidthM / arm.inLanes;
      const nearLanes = Math.max(1, Math.floor(fly.landingWidthM / laneW + 0.5));
      // inbound: far part to split node d{k}, then the at-grade near link to the box
      const split = add(scale(e, dS), n, -arm.inWidthM / 2);
      nodes.push({ id: `d${k}`, x: split[0], y: split[1], kind: 'diverge', layer: 0 });
      link(`arm${k}_in`, `a${k}s`, `d${k}`, inStart, split, arm.inWidthM, arm.inLanes);
      link(`arm${k}_in_near`, `d${k}`, 'J', add(scale(e, dS), n, -off), add(scale(e, r0), n, -off), fly.landingWidthM, nearLanes);
      // outbound: at-grade near link from the box to merge node m{k}, then the far part
      const mpt = add(scale(e, dS), n, arm.outWidthM / 2);
      nodes.push({ id: `m${k}`, x: mpt[0], y: mpt[1], kind: 'merge', layer: 0 });
      link(`arm${k}_out_near`, 'J', `m${k}`, add(scale(e, r0), n, off), add(scale(e, dS), n, off), fly.landingWidthM, nearLanes);
      link(`arm${k}_out`, `m${k}`, `a${k}e`, mpt, outEnd, arm.outWidthM, arm.outLanes);
      geo.push({ e, n, inLink: `arm${k}_in_near`, inW: fly.landingWidthM, inLanes: nearLanes, outLink: `arm${k}_out_near`, outW: fly.landingWidthM });
    } else {
      link(`arm${k}_in`, `a${k}s`, 'J', inStart, inEnd, arm.inWidthM, arm.inLanes);
      link(`arm${k}_out`, 'J', `a${k}e`, outStart, outEnd, arm.outWidthM, arm.outLanes);
      geo.push({ e, n, inLink: `arm${k}_in`, inW: arm.inWidthM, inLanes: arm.inLanes, outLink: `arm${k}_out`, outW: arm.outWidthM });
    }
    zones.push({ id: `arm${k}_in`, link: `arm${k}_in`, role: 'in' });
    zones.push({ id: `arm${k}_out`, link: `arm${k}_out`, role: 'out' });
  });

  const linkById = new Map(links.map((l) => [l.id, l]));
  const end = (id: string) => linkById.get(id)!.polyline[1] as V;
  const start = (id: string) => linkById.get(id)!.polyline[0] as V;

  // Box movements m{i}_{k}
  const major = p.majorArms ? new Set(p.majorArms) : new Set<number>();
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      if (i === k) continue;
      const gi = geo[i]!;
      const gk = geo[k]!;
      const P0 = end(gi.inLink);
      const P3 = start(gk.outLink);
      const d = 0.4 * dist(P0, P3);
      const path = bezier(P0, add(P0, gi.e, -d), add(P3, gk.e, -d), P3);
      const turn = turnOf(gi.e, gk.e);
      const lw = gi.inW / gi.inLanes;
      let from: [number, number];
      if (gi.inLanes === 1 || turn === 'through') from = [0, gi.inW];
      else if (turn === 'left') from = [0, lw];
      else from = [(gi.inLanes - 1) * lw, gi.inW];
      const w = Math.min(from[1] - from[0], gk.outW);
      const t0 = turn === 'left' ? 0 : turn === 'right' ? gk.outW - w : Math.min(Math.max(from[0], 0), gk.outW - w);
      let control: MovementControl = 'signal';
      if (!signal) {
        const between = major.has(i) && major.has(k);
        control = between || (major.has(i) && turn === 'left') ? 'major' : 'minor';
      }
      movements.push({
        id: `m${i}_${k}`,
        node: 'J',
        fromLink: gi.inLink,
        toLink: gk.outLink,
        path,
        widthM: w,
        fromLateral: from,
        toLateral: [t0, t0 + w],
        control,
      });
    }
  }

  // Flyover carriageways (both directions)
  if (fly) {
    const H = fly.heightM;
    for (const [X, Y] of [
      [fly.armA, fly.armB],
      [fly.armB, fly.armA],
    ] as const) {
      const gx = geo[X]!;
      const gy = geo[Y]!;
      const dS = r0 + fly.rampLengthM + 20;
      const rW = fly.rampWidthM;
      const inW = arms[X]!.inWidthM;
      const outW = arms[Y]!.outWidthM;
      const upA = add(scale(gx.e, dS), gx.n, -rW / 2);
      const upB = add(scale(gx.e, r0 + 20), gx.n, -rW / 2);
      const deckA = add(scale(gx.e, r0 + 20), gx.n, -fly.deckWidthM / 2);
      const deckB = add(scale(gy.e, r0 + 20), gy.n, fly.deckWidthM / 2);
      const dnA = add(scale(gy.e, r0 + 20), gy.n, rW / 2);
      const dnB = add(scale(gy.e, dS), gy.n, rW / 2);
      const fa = `f${X}${Y}a`;
      const fb = `f${X}${Y}b`;
      nodes.push({ id: fa, x: upB[0], y: upB[1], kind: 'plain', layer: 1 });
      nodes.push({ id: fb, x: deckB[0], y: deckB[1], kind: 'plain', layer: 1 });
      const ext = (z0: number, z1: number) => ({ layer: 1, zFromM: z0, zToM: z1 });
      link(`fly${X}${Y}_up`, `d${X}`, fa, upA, upB, rW, 1, ext(0, H));
      link(`fly${X}${Y}_deck`, fa, fb, deckA, deckB, fly.deckWidthM, Math.max(1, Math.floor(fly.deckWidthM / 3.5 + 0.5)), ext(H, H));
      link(`fly${X}${Y}_down`, fb, `m${Y}`, dnA, dnB, rW, 1, ext(H, 0));
      const mv = (id: string, node: string, f: string, t: string, a: V, b: V, w: number, fl: [number, number], tl: [number, number], control: MovementControl) =>
        movements.push({ id, node, fromLink: f, toLink: t, path: [a, b], widthM: w, fromLateral: fl, toLateral: tl, control });
      // split: ramp takes the median side of the approach, the near link the kerb side
      mv(`d${X}_${Y}up`, `d${X}`, `arm${X}_in`, `fly${X}${Y}_up`, end(`arm${X}_in`), upA, rW, [inW - rW, inW], [0, rW], 'free');
      if (!movements.some((m) => m.id === `d${X}_near`)) {
        const lW = fly.landingWidthM;
        mv(`d${X}_near`, `d${X}`, `arm${X}_in`, `arm${X}_in_near`, end(`arm${X}_in`), start(`arm${X}_in_near`), lW, [0, lW], [0, lW], 'free');
      }
      mv(`f${X}${Y}_ud`, fa, `fly${X}${Y}_up`, `fly${X}${Y}_deck`, upB, deckA, rW, [0, rW], [0, rW], 'free');
      mv(`f${X}${Y}_dd`, fb, `fly${X}${Y}_deck`, `fly${X}${Y}_down`, deckB, dnA, rW, [0, rW], [0, rW], 'free');
      // merge onto the far outbound link: deck traffic (major) on the median side, near (minor) on the kerb side
      mv(`m${Y}_fly`, `m${Y}`, `fly${X}${Y}_down`, `arm${Y}_out`, dnB, start(`arm${Y}_out`), rW, [0, rW], [outW - rW, outW], 'major');
      if (!movements.some((m) => m.id === `m${Y}_near`)) {
        const lW = fly.landingWidthM;
        mv(`m${Y}_near`, `m${Y}`, `arm${Y}_out_near`, `arm${Y}_out`, end(`arm${Y}_out_near`), start(`arm${Y}_out`), lW, [0, lW], [0, lW], 'minor');
      }
    }
  }

  const signals: SignalPlan[] = signal
    ? [
        {
          node: 'J',
          offsetS: 0,
          amberS: 3,
          allRedS: 2,
          phases: geo.map((_, k) => ({
            greenS: 25,
            protected: movements.filter((m) => m.node === 'J' && m.id.startsWith(`m${k}_`)).map((m) => m.id),
            permissive: [],
          })),
        },
      ]
    : [];

  return {
    version: 1,
    id: 'junction',
    name: `${N}-arm junction${fly ? ' with flyover' : ''}`,
    nodes,
    links,
    movements,
    signals,
    zones,
  };
}
