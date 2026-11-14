import { Purpose, substream } from '../core/rng.ts';
import { idmAccel, type IdmParams } from '../models/idm.ts';
import { ballistic } from '../models/integrate.ts';
import { buildNetwork, mapLateral, pointAt, type BuiltNetwork, type Segment } from '../network/build.ts';
import { laneStrip, occupiedStrips } from '../network/strips.ts';
import { FRAME_STRIDE, F_CLASS, F_HEADING, F_LAYER, F_LENGTH, F_WIDTH, F_X, F_Y } from '../protocol.ts';
import type { ClassSet, VehicleClass, VehicleClassId } from '../schema/classes.ts';
import type { Dist } from '../schema/common.ts';
import type { Network } from '../schema/network.ts';
import { Scenario, type ScenarioInput } from '../schema/scenario.ts';
import { generateNetwork } from '../scenarios/generators/index.ts';

export interface VehicleView {
  id: number;
  classId: VehicleClassId;
  link: string;
  s: number;
  y: number;
  v: number;
  a: number;
  length: number;
  width: number;
  lo: number;
  hi: number;
}

export interface SimCounters {
  generated: number;
  exited: number;
  onNetwork: number;
  entryQueue: number;
}

export interface Sim {
  readonly t: number;
  readonly step: number;
  readonly dt: number;
  readonly network: Network;
  advance(steps?: number): void;
  vehicles(): VehicleView[];
  vehicleCount(): number;
  stateHash(): string;
  counters(): SimCounters;
  writeFrame(out: Float32Array): number;
}

export interface SimInput {
  scenario: ScenarioInput;
  classes: ClassSet;
  network?: Network;
}

interface Route {
  segs: number[];
  loop: boolean;
}

const INIT_ID_BASE = 0x40000000;

/** Sample a size distribution with one uniform draw (piecewise-linear inverse CDF). */
export function sampleDist(d: Dist, u: number): number {
  if (d.kind === 'fixed') return d.value;
  const q = d.q;
  const pos = u * (q.length - 1);
  const i = Math.floor(pos);
  if (i >= q.length - 1) return q[q.length - 1]!;
  return q[i]! + (pos - i) * (q[i + 1]! - q[i]!);
}

/** Structure-of-arrays vehicle store with slot reuse. */
class Store {
  cap = 0;
  alive!: Uint8Array;
  id!: Float64Array;
  cls!: Uint8Array;
  seg!: Int32Array;
  route!: Int32Array;
  rpos!: Int32Array;
  s!: Float64Array;
  y!: Float64Array;
  v!: Float64Array;
  a!: Float64Array;
  len!: Float64Array;
  wid!: Float64Array;
  v0!: Float64Array;
  T!: Float64Array;
  s0!: Float64Array;
  am!: Float64Array;
  b!: Float64Array;
  c0!: Float64Array;
  c1!: Float64Array;
  lo!: Int32Array;
  hi!: Int32Array;
  free: number[] = [];
  count = 0;

  constructor(cap: number) {
    this.grow(Math.max(cap, 64));
  }

  private grow(cap: number): void {
    const f64 = (old?: Float64Array) => {
      const n = new Float64Array(cap);
      if (old) n.set(old);
      return n;
    };
    const i32 = (old?: Int32Array) => {
      const n = new Int32Array(cap);
      if (old) n.set(old);
      return n;
    };
    const u8 = (old?: Uint8Array) => {
      const n = new Uint8Array(cap);
      if (old) n.set(old);
      return n;
    };
    for (let k = cap - 1; k >= this.cap; k--) this.free.push(k);
    this.alive = u8(this.alive);
    this.cls = u8(this.cls);
    this.id = f64(this.id);
    this.s = f64(this.s);
    this.y = f64(this.y);
    this.v = f64(this.v);
    this.a = f64(this.a);
    this.len = f64(this.len);
    this.wid = f64(this.wid);
    this.v0 = f64(this.v0);
    this.T = f64(this.T);
    this.s0 = f64(this.s0);
    this.am = f64(this.am);
    this.b = f64(this.b);
    this.c0 = f64(this.c0);
    this.c1 = f64(this.c1);
    this.seg = i32(this.seg);
    this.route = i32(this.route);
    this.rpos = i32(this.rpos);
    this.lo = i32(this.lo);
    this.hi = i32(this.hi);
    this.cap = cap;
  }

  alloc(): number {
    if (this.free.length === 0) this.grow(this.cap * 2);
    const k = this.free.pop()!;
    this.alive[k] = 1;
    this.count++;
    return k;
  }

  release(k: number): void {
    this.alive[k] = 0;
    this.free.push(k);
    this.count--;
  }
}

class SimImpl implements Sim {
  t = 0;
  step = 0;
  readonly dt: number;
  readonly network: Network;
  private scenario: Scenario;
  private classes: VehicleClass[];
  private net: BuiltNetwork;
  private segs: Segment[];
  private routes: Route[] = [];
  private st: Store;
  /** Occupants per segment, kept sorted by (s, id). */
  private occ: number[][];
  private maxLen = 0;
  private generated = 0;
  private exited = 0;

  constructor(input: SimInput) {
    this.scenario = Scenario.parse(input.scenario);
    this.classes = input.classes.classes;
    this.dt = this.scenario.dtS;
    const src = this.scenario.network;
    const network = src.kind === 'generator' ? generateNetwork(src.params) : input.network;
    if (!network) throw new Error(`scenario network '${src.kind === 'file' ? src.id : ''}' requires a network`);
    this.network = network;
    this.net = buildNetwork(network, this.scenario.mode, this.scenario.stripWidthM);
    this.segs = this.net.segments;
    this.occ = this.segs.map(() => []);
    this.st = new Store(256);
    this.placeInitial();
    this.refreshStrips();
  }

  /* ---------------- set-up ---------------- */

  private classShares(): number[] {
    const comp = this.scenario.composition as Partial<Record<VehicleClassId, number>>;
    return this.classes.map((c) => comp[c.id] ?? 0);
  }

  /** Default route from a link: follow the first outgoing movement until a dead end or a cycle. */
  private routeFrom(linkSeg: number): number {
    const segs = [linkSeg];
    const seen = new Set([linkSeg]);
    let cur = linkSeg;
    let loop = false;
    for (;;) {
      const nxt = this.segs[cur]!.next[0];
      if (nxt === undefined) break;
      if (seen.has(nxt)) {
        loop = nxt === linkSeg;
        break;
      }
      segs.push(nxt);
      seen.add(nxt);
      cur = nxt;
    }
    this.routes.push({ segs, loop });
    return this.routes.length - 1;
  }

  private spawn(id: number, segIdx: number, routeIdx: number, rpos: number, s: number, laneK: number): number {
    const st = this.st;
    const vs = substream(this.scenario.seed, Purpose.vehicle, id);
    const shares = this.classShares();
    let total = 0;
    for (const x of shares) total += x;
    const u = vs.next() * total;
    let ci = shares.length - 1;
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      acc += shares[i]!;
      if (u < acc) {
        ci = i;
        break;
      }
    }
    const cls = this.classes[ci]!;
    const length = sampleDist(cls.lengthM, vs.next());
    const width = sampleDist(cls.widthM, vs.next());
    const ds = substream(this.scenario.seed, Purpose.driver, id);
    const drv = (p: { value: number; spread: number }) => p.value * (1 + p.spread * ds.uniform(-1, 1));
    const k = st.alloc();
    st.id[k] = id;
    st.cls[k] = ci;
    st.seg[k] = segIdx;
    st.route[k] = routeIdx;
    st.rpos[k] = rpos;
    st.s[k] = s;
    const seg = this.segs[segIdx]!;
    const lanes = this.network.links[segIdx]?.lanes ?? 1;
    const laneW = seg.widthM / lanes;
    st.y[k] = (laneK % lanes) * laneW + laneW / 2;
    st.v[k] = 0;
    st.a[k] = 0;
    st.len[k] = length;
    st.wid[k] = width;
    st.v0[k] = drv(cls.idm.v0);
    st.T[k] = drv(cls.idm.T);
    st.s0[k] = drv(cls.idm.s0);
    st.am[k] = drv(cls.idm.a);
    st.b[k] = drv(cls.idm.b);
    st.c0[k] = cls.clearance.c0.value;
    st.c1[k] = cls.clearance.c1.value;
    if (length > this.maxLen) this.maxLen = length;
    this.occ[segIdx]!.push(k);
    this.generated++;
    return k;
  }

  private placeInitial(): void {
    const dens = this.scenario.initialDensityPerKm;
    if (dens <= 0) return;
    const jitter = this.scenario.initialJitterM;
    const init = substream(this.scenario.seed, Purpose.init, 0);
    let nextId = INIT_ID_BASE;
    for (let li = 0; li < this.net.nLinks; li++) {
      const seg = this.segs[li]!;
      const L = seg.length;
      const n = Math.floor((dens * L) / 1000 + 0.5);
      if (n === 0) continue;
      const routeIdx = this.routeFrom(li);
      const loop = this.routes[routeIdx]!.loop;
      for (let k = 0; k < n; k++) {
        let s = ((k + 0.5) * L) / n + init.uniform(-jitter, jitter);
        if (loop) s = s - Math.floor(s / L) * L;
        else s = Math.min(Math.max(s, 0), L);
        this.spawn(nextId++, li, routeIdx, 0, s, k);
      }
    }
    for (const list of this.occ) this.sortOcc(list);
  }

  /* ---------------- per-step machinery ---------------- */

  private sortOcc(list: number[]): void {
    // Insertion sort: occupants are nearly sorted from the previous step.
    const { s, id } = this.st;
    for (let i = 1; i < list.length; i++) {
      const k = list[i]!;
      let j = i - 1;
      while (j >= 0 && (s[list[j]!]! > s[k]! || (s[list[j]!]! === s[k]! && id[list[j]!]! > id[k]!))) {
        list[j + 1] = list[j]!;
        j--;
      }
      list[j + 1] = k;
    }
  }

  private stripsAt(k: number, seg: Segment, y: number): [number, number] {
    if (this.scenario.mode === 'lane') return laneStrip(y, seg.layout);
    const st = this.st;
    return occupiedStrips(y, st.wid[k]!, st.c0[k]! + st.c1[k]! * st.v[k]!, seg.layout);
  }

  private refreshStrips(): void {
    const st = this.st;
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const [lo, hi] = this.stripsAt(k, this.segs[st.seg[k]!]!, st.y[k]!);
      st.lo[k] = lo;
      st.hi[k] = hi;
    }
  }

  private nextSeg(route: Route, rpos: number): { seg: number; rpos: number } | null {
    if (rpos + 1 < route.segs.length) return { seg: route.segs[rpos + 1]!, rpos: rpos + 1 };
    if (route.loop) return { seg: route.segs[0]!, rpos: 0 };
    return null;
  }

  /**
   * Leader of slot k (MODEL.md §1.6): nearest rear end among strip-overlapping vehicles ahead,
   * searched along the route up to the look-ahead D. Returns the gap and the leader speed.
   */
  private leaderOf(k: number, posInOcc: number): { gap: number; vl: number } {
    const st = this.st;
    const sI = st.s[k]!;
    const vI = st.v[k]!;
    const D = Math.max(150, (vI * vI) / (2 * st.b[k]!) + 50);
    const maxLen = this.maxLen;
    let bestRear = Infinity;
    let bestId = Infinity;
    let vl = 0;
    const consider = (j: number, frontOff: number, lo: number, hi: number): boolean => {
      if (frontOff - maxLen > bestRear) return false; // nothing further can be nearer
      if (j === k) return true;
      if (st.lo[j]! > hi || lo > st.hi[j]!) return true;
      const rear = frontOff - st.len[j]!;
      if (rear < bestRear || (rear === bestRear && st.id[j]! < bestId)) {
        bestRear = rear;
        bestId = st.id[j]!;
        vl = st.v[j]!;
      }
      return true;
    };
    let seg = this.segs[st.seg[k]!]!;
    const own = this.occ[seg.index]!;
    for (let m = posInOcc + 1; m < own.length; m++) {
      const j = own[m]!;
      if (!consider(j, st.s[j]! - sI, st.lo[k]!, st.hi[k]!)) break;
    }
    // Continue along the route while a nearer rear could still exist within D.
    const route = this.routes[st.route[k]!]!;
    let rpos = st.rpos[k]!;
    let off = seg.length - sI;
    let y = st.y[k]!;
    while (off - maxLen < bestRear && off < D) {
      const nx = this.nextSeg(route, rpos);
      if (!nx) break;
      const nseg = this.segs[nx.seg]!;
      y = mapLateral(seg, nseg, y);
      const [lo, hi] = this.stripsAt(k, nseg, y);
      const list = this.occ[nseg.index]!;
      for (let m = 0; m < list.length; m++) {
        const j = list[m]!;
        if (!consider(j, off + st.s[j]!, lo, hi)) break;
      }
      off += nseg.length;
      rpos = nx.rpos;
      seg = nseg;
    }
    if (bestRear > D) return { gap: Infinity, vl: 0 };
    return { gap: bestRear, vl };
  }

  advance(steps = 1): void {
    for (let n = 0; n < steps; n++) this.stepOnce();
  }

  private stepOnce(): void {
    const st = this.st;
    const dt = this.dt;
    // 1. Snapshot: accelerations for every vehicle from the current state.
    const p: IdmParams = { v0: 0, T: 0, s0: 0, a: 0, b: 0 };
    for (const list of this.occ) {
      for (let m = 0; m < list.length; m++) {
        const k = list[m]!;
        const { gap, vl } = this.leaderOf(k, m);
        const seg = this.segs[st.seg[k]!]!;
        p.v0 = Math.min(st.v0[k]!, seg.speedLimitMps);
        p.T = st.T[k]!;
        p.s0 = st.s0[k]!;
        p.a = st.am[k]!;
        p.b = st.b[k]!;
        st.a[k] = idmAccel(p, st.v[k]!, gap, st.v[k]! - vl);
      }
    }
    // 3. Integrate.
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const r = ballistic(st.s[k]!, st.v[k]!, st.a[k]!, dt);
      st.s[k] = r.x;
      st.v[k] = r.v;
    }
    // 4. Transfer across segment ends; remove finished vehicles.
    let moved = false;
    for (let g = 0; g < this.occ.length; g++) {
      const list = this.occ[g]!;
      for (let m = list.length - 1; m >= 0; m--) {
        const k = list[m]!;
        let seg = this.segs[st.seg[k]!]!;
        if (st.s[k]! < seg.length) continue;
        list.splice(m, 1);
        moved = true;
        const route = this.routes[st.route[k]!]!;
        let gone = false;
        while (st.s[k]! >= seg.length) {
          const nx = this.nextSeg(route, st.rpos[k]!);
          if (!nx) {
            gone = true;
            break;
          }
          st.s[k] = st.s[k]! - seg.length;
          const nseg = this.segs[nx.seg]!;
          st.y[k] = mapLateral(seg, nseg, st.y[k]!);
          st.seg[k] = nx.seg;
          st.rpos[k] = nx.rpos;
          seg = nseg;
        }
        if (gone) {
          st.release(k);
          this.exited++;
        } else {
          pendingPush.push(k);
        }
      }
    }
    if (moved) {
      for (const k of pendingPush) this.occ[st.seg[k]!]!.push(k);
      pendingPush.length = 0;
    }
    for (const list of this.occ) this.sortOcc(list);
    this.refreshStrips();
    this.t = (this.step + 1) * dt;
    this.step++;
  }

  /* ---------------- outputs ---------------- */

  private sortedSlots(): number[] {
    const st = this.st;
    const out: number[] = [];
    for (let k = 0; k < st.cap; k++) if (st.alive[k]) out.push(k);
    out.sort((a, b) => st.id[a]! - st.id[b]!);
    return out;
  }

  vehicles(): VehicleView[] {
    const st = this.st;
    return this.sortedSlots().map((k) => ({
      id: st.id[k]!,
      classId: this.classes[st.cls[k]!]!.id,
      link: this.segs[st.seg[k]!]!.id,
      s: st.s[k]!,
      y: st.y[k]!,
      v: st.v[k]!,
      a: st.a[k]!,
      length: st.len[k]!,
      width: st.wid[k]!,
      lo: st.lo[k]!,
      hi: st.hi[k]!,
    }));
  }

  vehicleCount(): number {
    return this.st.count;
  }

  counters(): SimCounters {
    return { generated: this.generated, exited: this.exited, onNetwork: this.st.count, entryQueue: 0 };
  }

  stateHash(): string {
    const st = this.st;
    const dv = hashView;
    let h = 0x811c9dc5;
    const feed = (bytes: number) => {
      for (let i = 0; i < bytes; i++) h = Math.imul(h ^ dv.getUint8(i), 0x01000193);
    };
    for (const k of this.sortedSlots()) {
      dv.setUint32(0, st.id[k]! >>> 0, true);
      feed(4);
      dv.setUint32(0, st.seg[k]! >>> 0, true);
      feed(4);
      dv.setFloat64(0, st.s[k]!, true);
      feed(8);
      dv.setFloat64(0, st.y[k]!, true);
      feed(8);
      dv.setFloat64(0, st.v[k]!, true);
      feed(8);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  writeFrame(out: Float32Array): number {
    const st = this.st;
    let n = 0;
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      if ((n + 1) * FRAME_STRIDE > out.length) break;
      const seg = this.segs[st.seg[k]!]!;
      const sc = st.s[k]! - st.len[k]! / 2;
      const pt = pointAt(seg, sc);
      const off = seg.widthM / 2 - st.y[k]!;
      const o = n * FRAME_STRIDE;
      out[o + F_X] = pt.x - pt.ty * off;
      out[o + F_Y] = pt.y + pt.tx * off;
      out[o + F_HEADING] = Math.atan2(pt.ty, pt.tx);
      out[o + F_CLASS] = st.cls[k]!;
      out[o + F_LENGTH] = st.len[k]!;
      out[o + F_WIDTH] = st.wid[k]!;
      out[o + F_LAYER] = seg.layer;
      n++;
    }
    return n;
  }
}

const pendingPush: number[] = [];
const hashView = new DataView(new ArrayBuffer(8));

export function createSim(input: SimInput): Sim {
  return new SimImpl(input);
}
