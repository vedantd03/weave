/**
 * T23 — junction and merge generators (docs/MODEL.md §3.5, §3.6). Expected geometry is computed
 * in the test from the spec formulas. Assumptions (flagged in the report): the junction centre
 * is the origin, arms are indexed from 0 in the order of `arms`, and Bézier samples are at
 * t = j/16.
 */
import { describe, expect, it } from 'vitest';
import { generateNetwork } from '../../src/index.ts';
import { GeneratorParams, Network } from '../../src/schema/index.ts';
import type { Arm } from '../helpers/m3.ts';

type V = [number, number];
const E = 1e-9;
const rad = (d: number) => (d * Math.PI) / 180;
const e = (deg: number): V => [Math.cos(rad(deg)), Math.sin(rad(deg))];
const nrm = (deg: number): V => [-Math.sin(rad(deg)), Math.cos(rad(deg))];
const add = (a: V, b: V, k = 1): V => [a[0] + k * b[0], a[1] + k * b[1]];
const expectPt = (p: readonly number[], q: V, tol = 1e-6) => {
  expect(Math.abs(p[0]! - q[0])).toBeLessThanOrEqual(tol);
  expect(Math.abs(p[1]! - q[1])).toBeLessThanOrEqual(tol);
};
const gen = (p: unknown): Network => Network.parse(generateNetwork(GeneratorParams.parse(p)));

const ARMS: Arm[] = [
  { angleDeg: 0, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 200 },
  { angleDeg: 90, inWidthM: 3.5, outWidthM: 3.5, inLanes: 1, outLanes: 1, lengthM: 200 },
  { angleDeg: 180, inWidthM: 10.5, outWidthM: 7, inLanes: 3, outLanes: 2, lengthM: 200 },
  { angleDeg: 270, inWidthM: 3.5, outWidthM: 3.5, inLanes: 1, outLanes: 1, lengthM: 200 },
];
const R0 = 0.5 * Math.max(...ARMS.map((a) => a.inWidthM + a.outWidthM)) + 4; // 12.75

/** turning angle from heading −e_i to e_k, normalised to (−180, 180] */
function turn(i: number, k: number): 'through' | 'left' | 'right' {
  const h = e(ARMS[i]!.angleDeg).map((x) => -x) as V;
  const t = e(ARMS[k]!.angleDeg);
  const d = (Math.atan2(h[0] * t[1] - h[1] * t[0], h[0] * t[0] + h[1] * t[1]) * 180) / Math.PI;
  if (Math.abs(d) < 30) return 'through';
  return d > 0 ? 'left' : 'right';
}

describe('T23 junction generator geometry (§3.5)', () => {
  const net = gen({ generator: 'junction', arms: ARMS, control: 'signal' });
  const link = (id: string) => net.links.find((l) => l.id === id)!;

  it('arm links: inbound offset −n·inW/2 from r0 + L to r0, outbound +n·outW/2 from r0 to r0 + L', () => {
    ARMS.forEach((a, k) => {
      const ek = e(a.angleDeg);
      const nk = nrm(a.angleDeg);
      const inL = link(`arm${k}_in`);
      const outL = link(`arm${k}_out`);
      expectPt(inL.polyline[0]!, add(add([0, 0], ek, R0 + 200), nk, -a.inWidthM / 2));
      expectPt(inL.polyline[inL.polyline.length - 1]!, add(add([0, 0], ek, R0), nk, -a.inWidthM / 2));
      expectPt(outL.polyline[0]!, add(add([0, 0], ek, R0), nk, a.outWidthM / 2));
      expectPt(outL.polyline[outL.polyline.length - 1]!, add(add([0, 0], ek, R0 + 200), nk, a.outWidthM / 2));
      expect([inL.widthM, inL.lanes, outL.widthM, outL.lanes]).toEqual([a.inWidthM, a.inLanes, a.outWidthM, a.outLanes]);
    });
  });

  it('movements m{i}_{k} for every i ≠ k: cubic Bézier, 17 samples, d = 0.4·|P3 − P0|', () => {
    expect(net.movements.length).toBe(ARMS.length * (ARMS.length - 1));
    const nodes = new Set(net.movements.map((m) => m.node));
    expect(nodes.size).toBe(1);
    ARMS.forEach((ai, i) => {
      ARMS.forEach((ak, k) => {
        if (i === k) return;
        const m = net.movements.find((x) => x.id === `m${i}_${k}`)!;
        expect(m).toBeDefined();
        expect([m.fromLink, m.toLink]).toEqual([`arm${i}_in`, `arm${k}_out`]);
        const inL = link(`arm${i}_in`);
        const P0 = inL.polyline[inL.polyline.length - 1]! as V;
        const P3 = link(`arm${k}_out`).polyline[0]! as V;
        const d = 0.4 * Math.hypot(P3[0] - P0[0], P3[1] - P0[1]);
        const P1 = add(P0, e(ai.angleDeg), -d);
        const P2 = add(P3, e(ak.angleDeg), -d);
        expect(m.path.length).toBe(17);
        m.path.forEach((pt, j) => {
          const t = j / 16;
          const b0 = (1 - t) ** 3;
          const b1 = 3 * (1 - t) ** 2 * t;
          const b2 = 3 * (1 - t) * t * t;
          const b3 = t ** 3;
          expectPt(pt, [b0 * P0[0] + b1 * P1[0] + b2 * P2[0] + b3 * P3[0], b0 * P0[1] + b1 * P1[1] + b2 * P2[1] + b3 * P3[1]]);
        });
      });
    });
  });

  it('bands: 1 lane → [0, inW]; ≥ 2 lanes: left lane 0, right lane n−1, through all; toLateral per turn', () => {
    ARMS.forEach((ai, i) => {
      ARMS.forEach((ak, k) => {
        if (i === k) return;
        const m = net.movements.find((x) => x.id === `m${i}_${k}`)!;
        const lw = ai.inWidthM / ai.inLanes;
        const tt = turn(i, k);
        let band: V = [0, ai.inWidthM];
        if (ai.inLanes >= 2 && tt === 'left') band = [0, lw];
        if (ai.inLanes >= 2 && tt === 'right') band = [ai.inWidthM - lw, ai.inWidthM];
        expect(Math.abs(m.fromLateral[0] - band[0])).toBeLessThan(E);
        expect(Math.abs(m.fromLateral[1] - band[1])).toBeLessThan(E);
        const w = Math.min(band[1] - band[0], ak.outWidthM);
        expect(Math.abs(m.widthM - w)).toBeLessThan(E);
        const t0 = tt === 'left' ? 0 : tt === 'right' ? ak.outWidthM - w : Math.min(Math.max(band[0], 0), ak.outWidthM - w);
        expect(Math.abs(m.toLateral[0] - t0)).toBeLessThan(E);
        expect(Math.abs(m.toLateral[1] - (t0 + w))).toBeLessThan(E);
      });
    });
    // LHT sanity: from the east arm (heading west) north is a right turn, south a left turn
    expect(turn(0, 1)).toBe('right');
    expect(turn(0, 3)).toBe('left');
    expect(turn(0, 2)).toBe('through');
  });

  it('signal control: all movements signal; default split phasing 25/3/2, phase k = arm k', () => {
    expect(net.movements.every((m) => m.control === 'signal')).toBe(true);
    expect(net.signals.length).toBe(1);
    const p = net.signals[0]!;
    expect(p.node).toBe(net.movements[0]!.node);
    expect([p.amberS, p.allRedS, p.offsetS]).toEqual([3, 2, 0]);
    expect(p.phases.length).toBe(ARMS.length);
    p.phases.forEach((ph, k) => {
      expect(ph.greenS).toBe(25);
      expect([...ph.protected].sort()).toEqual(net.movements.filter((m) => m.fromLink === `arm${k}_in`).map((m) => m.id).sort());
    });
  });

  it('zones arm{k}_in / arm{k}_out on the arm links', () => {
    for (let k = 0; k < ARMS.length; k++) {
      expect(net.zones.find((z) => z.id === `arm${k}_in`)).toMatchObject({ link: `arm${k}_in`, role: 'in' });
      expect(net.zones.find((z) => z.id === `arm${k}_out`)).toMatchObject({ link: `arm${k}_out`, role: 'out' });
    }
  });

  it('priority control: movements between the major arms and left turns from them are major', () => {
    const pn = gen({ generator: 'junction', arms: ARMS, control: 'priority', majorArms: [0, 2] });
    expect(pn.signals).toEqual([]);
    expect(pn.nodes.find((n) => n.id === pn.movements[0]!.node)!.kind).toBe('priority');
    for (const m of pn.movements) {
      const [, i, k] = /^m(\d+)_(\d+)$/.exec(m.id)!.map(Number) as [number, number, number];
      const between = (i === 0 && k === 2) || (i === 2 && k === 0);
      const leftFromMajor = (i === 0 || i === 2) && turn(i, k) === 'left';
      expect(m.control, m.id).toBe(between || leftFromMajor ? 'major' : 'minor');
    }
  });
});

describe('T23 flyover (§3.5)', () => {
  const arms: Arm[] = [0, 90, 180, 270].map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
  const fly = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 };
  const on = gen({ generator: 'junction', arms, control: 'signal', flyover: fly });
  const off = gen({ generator: 'junction', arms, control: 'signal', flyover: { ...fly, enabled: false } });
  const L = (id: string) => on.links.find((l) => l.id === id)!;
  const nodeOf = (id: string) => on.nodes.find((n) => n.id === id)!;

  it('zone ids identical with flyover on/off; zones stay on the far arm links', () => {
    const ids = (n: Network) => n.zones.map((z) => `${z.id}@${z.link}`).sort();
    expect(ids(on)).toEqual(ids(off));
    expect(off.links.every((l) => l.layer === 0)).toBe(true);
  });

  for (const [X, Y] of [
    [0, 2],
    [2, 0],
  ] as const) {
    it(`direction ${X}→${Y}: links, layers, widths, z profile, movements and split bands`, () => {
      const up = L(`fly${X}${Y}_up`);
      const deck = L(`fly${X}${Y}_deck`);
      const down = L(`fly${X}${Y}_down`);
      expect([up.layer, deck.layer, down.layer]).toEqual([1, 1, 1]);
      expect([up.widthM, deck.widthM, down.widthM]).toEqual([3.5, 7, 3.5]);
      expect([up.zFromM, up.zToM, deck.zFromM, deck.zToM, down.zFromM, down.zToM]).toEqual([0, 6.5, 6.5, 6.5, 6.5, 0]);
      // ramps are exactly rampLength long (dX at r0 + rampLength + 20 → r0 + 20), so the
      // grade (T23) is height / rampLength
      const plen = (pl: readonly (readonly number[])[]) => {
        let s = 0;
        for (let i = 1; i < pl.length; i++) s += Math.hypot(pl[i]![0]! - pl[i - 1]![0]!, pl[i]![1]! - pl[i - 1]![1]!);
        return s;
      };
      const r0f = 0.5 * 14 + 4;
      expect(plen(up.polyline)).toBeCloseTo(fly.rampLengthM, 6);
      expect(plen(down.polyline)).toBeCloseTo(fly.rampLengthM, 6);
      expect((up.zToM - up.zFromM) / plen(up.polyline)).toBeCloseTo(6.5 / 120, 9);
      expect((down.zFromM - down.zToM) / plen(down.polyline)).toBeCloseTo(6.5 / 120, 9);
      // deck from r0 + 20 on arm X to r0 + 20 on arm Y (projections on the arm axes)
      const eX = e(arms[X]!.angleDeg);
      const eY = e(arms[Y]!.angleDeg);
      const d0 = deck.polyline[0]!;
      const d1 = deck.polyline[deck.polyline.length - 1]!;
      expect(d0[0]! * eX[0] + d0[1]! * eX[1]).toBeCloseTo(r0f + 20, 6);
      expect(d1[0]! * eY[0] + d1[1]! * eY[1]).toBeCloseTo(r0f + 20, 6);
      expect(L(`arm${X}_in_near`).widthM).toBe(3.5);
      expect(L(`arm${Y}_out_near`).widthM).toBe(3.5);
      expect(L(`arm${X}_in_near`).layer).toBe(0);
      // split node dX at distance r0 + rampLength + 20 along arm X (layer 0)
      const r0 = 0.5 * 14 + 4;
      const split = nodeOf(L(`arm${X}_in`).to);
      expect(split.layer).toBe(0);
      const ex = e(arms[X]!.angleDeg);
      expect(split.x * ex[0] + split.y * ex[1]).toBeCloseTo(r0 + fly.rampLengthM + 20, 6);
      expect(nodeOf(up.to).layer).toBe(1);
      expect(nodeOf(down.to).layer).toBe(0);
      const mv = (from: string, to: string) => on.movements.find((m) => m.fromLink === from && m.toLink === to)!;
      expect(mv(up.id, deck.id).control).toBe('free');
      expect(mv(deck.id, down.id).control).toBe('free');
      const toUp = mv(`arm${X}_in`, up.id);
      const toNear = mv(`arm${X}_in`, `arm${X}_in_near`);
      expect([toUp.control, toNear.control]).toEqual(['free', 'free']);
      expect(toUp.fromLateral).toEqual([7 - 3.5, 7]);
      expect(toNear.fromLateral).toEqual([0, 3.5]);
      expect(mv(down.id, `arm${Y}_out`).control).toBe('major');
      expect(mv(`arm${Y}_out_near`, `arm${Y}_out`).control).toBe('minor');
    });
  }
});

describe('T23 merge generator (§3.6)', () => {
  const net = gen({
    generator: 'merge', mainWidthM: 7, mainLanes: 2, rampWidthM: 3.5, taperM: 150, mainLengthM: 600, rampLengthM: 200, angleDeg: 15,
  });
  const link = (id: string) => net.links.find((l) => l.id === id)!;
  const mv = (from: string, to: string) => net.movements.find((m) => m.fromLink === from && m.toLink === to)!;

  it('links, widths and the acceleration lane length', () => {
    expect([link('main_up').widthM, link('main_up').lanes]).toEqual([7, 2]);
    expect([link('ramp').widthM, link('ramp').lanes]).toEqual([3.5, 1]);
    expect(link('accel').widthM).toBe(10.5);
    expect(link('main_down').widthM).toBe(7);
    let len = 0;
    const pl = link('accel').polyline;
    for (let i = 1; i < pl.length; i++) len += Math.hypot(pl[i]![0] - pl[i - 1]![0], pl[i]![1] - pl[i - 1]![1]);
    expect(len).toBeCloseTo(150, 6);
  });

  it('movements and bands: main → [rampW, rampW + mainW], ramp → [0, rampW]; accel → main_down', () => {
    const a = mv('main_up', 'accel');
    const b = mv('ramp', 'accel');
    const c = mv('accel', 'main_down');
    expect([a.control, b.control]).toEqual(['free', 'free']);
    expect(a.toLateral).toEqual([3.5, 10.5]);
    expect(b.toLateral).toEqual([0, 3.5]);
    expect(c.fromLateral).toEqual([3.5, 10.5]);
    expect(c.toLateral).toEqual([0, 7]);
    expect(a.node).toBe(b.node);
    expect(net.nodes.find((n) => n.id === a.node)!.id).toBe('n1');
  });

  it('zones main_in, ramp_in, main_out', () => {
    const z = Object.fromEntries(net.zones.map((x) => [x.id, [x.link, x.role]]));
    expect(z).toEqual({ main_in: ['main_up', 'in'], ramp_in: ['ramp', 'in'], main_out: ['main_down', 'out'] });
  });
});
