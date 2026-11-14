import { Purpose, substream, type Rng } from '../core/rng.ts';
import { idmAccel, type IdmParams } from '../models/idm.ts';
import { ballistic } from '../models/integrate.ts';
import { buildNetwork, mapLateral, pointAt, type BuiltNetwork, type Segment } from '../network/build.ts';
import { laneStrip, occupiedStrips, sweptStrips } from '../network/strips.ts';
import { FRAME_STRIDE, F_CLASS, F_HEADING, F_LAYER, F_LENGTH, F_WIDTH, F_X, F_Y } from '../protocol.ts';
import type { ClassSet, VehicleClass, VehicleClassId } from '../schema/classes.ts';
import type { Dist } from '../schema/common.ts';
import type { Network } from '../schema/network.ts';
import { Scenario, type ScenarioInput } from '../schema/scenario.ts';
import { generateNetwork } from '../scenarios/generators/index.ts';
import { computeConflicts } from '../network/conflicts.ts';
import { SIG, signalState } from '../junction/signals.ts';
import { acceptGap } from '../junction/gap.ts';
import type { MovementControl, SignalPlan } from '../schema/network.ts';

/* ---------------- public types (docs/MODEL.md §1.7, §2.7, §2.8) ---------------- */

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
  targetY: number;
  /** Free-flow time for the distance travelled so far (§5.2). */
  freeFlowTravelledS: number;
}

export interface SimCounters {
  generated: number;
  exited: number;
  onNetwork: number;
  entryQueue: number;
}

export interface LinkStats {
  entered: number;
  exited: number;
  vehicleSeconds: number;
  travelTimeSum: number;
  travelTimeCount: number;
}

export interface TripRecord {
  id: number;
  origin: string;
  destination: string;
  classId: VehicleClassId;
  tGen: number;
  tInsert: number;
  tExit: number;
  freeFlowS: number;
}

export interface GeneratedRecord {
  id: number;
  origin: string;
  destination: string;
  classId: VehicleClassId;
  tGen: number;
  length: number;
  width: number;
  v0: number;
  T: number;
  s0: number;
  a: number;
  b: number;
  /** Free-flow time of the vehicle's route at its own desired speed (§2.7). */
  freeFlowS: number;
}

export interface SeriesRow {
  t0: number;
  t1: number;
  generated: number;
  inserted: number;
  exited: number;
  exitFlowVph: number;
  meanSpeedMps: number;
  densityPerKm: number;
  entryQueue: number;
  onNetwork: number;
  /** Junctions locked at the end of the window (§3.4 item 6). */
  lockedJunctions: number;
}

export interface AddVehicleSpec {
  classId: VehicleClassId;
  link: string;
  s: number;
  y: number;
  v: number;
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
  linkStats(): Record<string, LinkStats>;
  trips(): TripRecord[];
  generatedLog(): GeneratedRecord[];
  series(): SeriesRow[];
  addVehicle(spec: AddVehicleSpec): number;
  writeFrame(out: Float32Array): number;
  diagnostics(): { guardActivations: number; vehicleSteps: number; holds: Record<string, number>; reroutes: number; diversions: number };
  /** Gridlock report (MODEL.md §3.4 item 6), or null when nothing is locked. */
  gridlock(): GridlockReport | null;
  /** Signal colour per network movement (index order), SIG codes; 255 = uncontrolled. */
  signalCodes(): Uint8Array;
  /** The fixed route of every OD row (segment ids, §2.1). */
  odRoutes(): { origin: string; destination: string; rateVph: number; segments: string[] }[];
}

export interface GridlockReport {
  detected: boolean;
  sinceS: number;
  junctions: { node: string; sinceS: number }[];
}

export interface SimInput {
  scenario: ScenarioInput;
  classes: ClassSet;
  network?: Network;
}

/* ---------------- constants (MODEL.md §2.4; engineering assumptions, ADR-004) ---------------- */

export const B_SAFE = 4;
const TAU_REACH_S = 1;
const LANE_CHANGE_S = 3;
const WAIVER_M = 30;
const SERIES_WINDOW_S = 60;
const EPS = 1e-9;
const GUARD_GAP_M = 1e-6;
/** A vehicle stuck this long at a lane-band obstacle takes the branch it fits (§2.2). */
const REROUTE_AFTER_S = 20;
/** Route-cost junction penalty (§2.1, assumption): expected delay per controlled movement. */
const PENALTY_SIGNAL_S = 15;
const PENALTY_MINOR_S = 5;
const GRIDLOCK_S = 300;
/** Vehicles slower than this beyond the box count as a standing queue for the box rule. */
const BOX_QUEUE_SPEED = 2;
const REGION_M = 50;

/** A movement's band cannot be wider than the movement itself (§2.2). */
function effBand(m: Segment): [number, number] {
  const b0 = m.fromLateral[0];
  const b1 = Math.min(m.fromLateral[1], b0 + m.widthM);
  return [b0, b1];
}

const INIT_ID_BASE = 0x40000000;
const ADDED_ID_BASE = 0x50000000;
const ORIGIN_ID_STRIDE = 1 << 20;

/** Sample a size distribution with one uniform draw (piecewise-linear inverse CDF). */
export function sampleDist(d: Dist, u: number): number {
  if (d.kind === 'fixed') return d.value;
  const q = d.q;
  const pos = u * (q.length - 1);
  const i = Math.floor(pos);
  if (i >= q.length - 1) return q[q.length - 1]!;
  return q[i]! + (pos - i) * (q[i + 1]! - q[i]!);
}

interface Route {
  segs: number[];
  loop: boolean;
}

interface Pending {
  id: number;
  origin: number;
  dest: number;
  cls: number;
  length: number;
  width: number;
  v0: number;
  T: number;
  s0: number;
  a: number;
  b: number;
  uLat: number;
  tGen: number;
  route: number;
}

interface Leader {
  gap: number;
  vl: number;
  slot: number;
}

interface Decision {
  k: number;
  target: number;
  lo: number;
  hi: number;
}

/** Structure-of-arrays vehicle store with slot reuse. */
class Store {
  cap = 0;
  count = 0;
  free: number[] = [];
  alive = new Uint8Array(0);
  cls = new Uint8Array(0);
  id = new Float64Array(0);
  seg = new Int32Array(0);
  route = new Int32Array(0);
  rpos = new Int32Array(0);
  s = new Float64Array(0);
  y = new Float64Array(0);
  ty = new Float64Array(0);
  v = new Float64Array(0);
  a = new Float64Array(0);
  dy = new Float64Array(0);
  len = new Float64Array(0);
  wid = new Float64Array(0);
  cOcc = new Float64Array(0);
  v0 = new Float64Array(0);
  T = new Float64Array(0);
  s0 = new Float64Array(0);
  am = new Float64Array(0);
  b = new Float64Array(0);
  lo = new Int32Array(0);
  hi = new Int32Array(0);
  origin = new Int32Array(0);
  dest = new Int32Array(0);
  tGen = new Float64Array(0);
  tIns = new Float64Array(0);
  tSeg = new Float64Array(0);
  /** Snapshot leader slot (−1: none or standing obstacle) and gap, for the collision guard. */
  lead = new Int32Array(0);
  leadGap = new Float64Array(0);
  ds = new Float64Array(0);
  /** Gap acceptance per driver (§3.3) and "don't block the box" compliance. */
  tc = new Float64Array(0);
  tf = new Float64Array(0);
  comply = new Uint8Array(0);
  /** Seconds stopped at a lane-band obstacle (deadlock breaker, §2.2). */
  stuck = new Float64Array(0);
  diverted = new Uint8Array(0);
  /** Free-flow seconds for the distance travelled since insertion (§5.2). */
  ffTrav = new Float64Array(0);

  constructor(cap: number) {
    this.grow(cap);
  }

  private grow(cap: number): void {
    const keys = Object.keys(this) as (keyof Store)[];
    for (const key of keys) {
      const arr = this[key] as unknown;
      if (ArrayBuffer.isView(arr) && !(arr instanceof DataView)) {
        const Ctor = (arr as unknown as { constructor: new (n: number) => Float64Array }).constructor;
        const next = new Ctor(cap);
        next.set(arr as unknown as Float64Array);
        (this as unknown as Record<string, unknown>)[key] = next;
      }
    }
    for (let k = cap - 1; k >= this.cap; k--) this.free.push(k);
    this.cap = cap;
  }

  alloc(): number {
    if (this.free.length === 0) this.grow(Math.max(64, this.cap * 2));
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
  private sc: Scenario;
  private classes: VehicleClass[];
  private net: BuiltNetwork;
  private segs: Segment[];
  private routes: Route[] = [];
  private routeCache = new Map<string, number>();
  private st = new Store(256);
  private occ: number[][];
  /** Segments whose `next` includes this one. */
  private preds: number[][];
  private maxLen = 0;
  private lane: boolean;

  // demand
  private origins: { zone: string; link: number; rate: number; rng: Rng; next: number; k: number; rows: { dest: number; rate: number }[] }[] = [];
  private destZones: { zone: string; link: number }[] = [];
  private queues: Pending[][] = [];

  // metrics
  private generated = 0;
  private exited = 0;
  private addedCount = 0;
  private guardHits = 0;
  private reroutes = 0;
  private diversions = 0;
  private guardBySeg: Record<number, number> = {};
  /** Why vehicles were held at junctions (counts of leader-search evaluations). */
  private holds = { red: 0, amber: 0, gap: 0, box: 0, occupied: 0 };
  /** Junction data per segment (movements only). */
  private conf: { other: number; type: 'crossing' | 'merging' | 'diverging'; self: [number, number]; oth: [number, number] }[][] = [];
  private ctrl: (MovementControl | null)[] = [];
  private plan: (SignalPlan | null)[] = [];
  private sigNow: Uint8Array = new Uint8Array(0);
  private lastEntry: Float64Array = new Float64Array(0);
  private isJunctionMove: Uint8Array = new Uint8Array(0);
  private junctions: { node: string; moves: number[]; inLinks: number[]; lastActive: number; lastCount: number }[] = [];
  private netLastActive = 0;
  private genSeen = 0;
  private insertedTotal = 0;
  private activeThisStep = false;
  private vehicleSteps = 0;
  private stats: LinkStats[];
  private tripLog: TripRecord[] = [];
  private genLog: GeneratedRecord[] = [];
  private rows: SeriesRow[] = [];
  private win = { t0: 0, generated: 0, inserted: 0, exited: 0, speedSum: 0, densSum: 0, samples: 0 };
  private linkKm: number;

  constructor(input: SimInput) {
    this.sc = Scenario.parse(input.scenario);
    this.classes = input.classes.classes;
    this.dt = this.sc.dtS;
    this.lane = this.sc.mode === 'lane';
    const src = this.sc.network;
    const network = src.kind === 'generator' ? generateNetwork(src.params) : input.network;
    if (!network) throw new Error(`scenario network '${src.kind === 'file' ? src.id : ''}' requires a network`);
    this.network = network;
    this.net = buildNetwork(network, this.sc.mode, this.sc.stripWidthM);
    this.segs = this.net.segments;
    this.occ = this.segs.map(() => []);
    this.setupJunctions();
    this.preds = this.segs.map(() => []);
    for (const seg of this.segs) for (const nx of seg.next) this.preds[nx]!.push(seg.index);
    this.stats = this.segs.map(() => ({ entered: 0, exited: 0, vehicleSeconds: 0, travelTimeSum: 0, travelTimeCount: 0 }));
    let km = 0;
    for (let i = 0; i < this.net.nLinks; i++) km += this.segs[i]!.length / 1000;
    this.linkKm = km;
    this.setupDemand();
    this.placeInitial();
    this.refreshStrips();
  }

  /* ================= set-up ================= */

  /** Conflicts, signal plans (with scenario overrides) and junction regions (§3). */
  private setupJunctions(): void {
    const n = this.segs.length;
    this.conf = this.segs.map(() => []);
    this.ctrl = new Array(n).fill(null);
    this.plan = new Array(n).fill(null);
    this.sigNow = new Uint8Array(n).fill(SIG.NONE);
    this.lastEntry = new Float64Array(n).fill(-Infinity);
    this.isJunctionMove = new Uint8Array(n);
    const plans = new Map<string, SignalPlan>();
    for (const p of this.network.signals) plans.set(p.node, p);
    for (const p of this.sc.signalOverrides) plans.set(p.node, p);
    const segOfMove = new Map<string, number>();
    for (const seg of this.segs) if (seg.kind === 'movement') segOfMove.set(seg.id, seg.index);
    const conflicts = computeConflicts(this.network);
    const movesByNode = new Map<string, number[]>();
    this.network.movements.forEach((m, mi) => {
      const g = this.net.nLinks + mi;
      this.ctrl[g] = m.control;
      const pl = plans.get(m.node);
      if (m.control === 'signal' && pl) this.plan[g] = pl;
      for (const c of conflicts.get(m.id) ?? []) {
        const o = segOfMove.get(c.movement);
        if (o !== undefined) this.conf[g]!.push({ other: o, type: c.type, self: [c.self[0], c.self[1]], oth: [c.other[0], c.other[1]] });
      }
      const list = movesByNode.get(m.node) ?? [];
      list.push(g);
      movesByNode.set(m.node, list);
    });
    for (const [node, moves] of movesByNode) {
      if (moves.length < 2) continue;
      for (const g of moves) this.isJunctionMove[g] = 1;
      const inLinks = [...new Set(moves.map((g) => this.net.segByLinkId.get(this.network.movements[g - this.net.nLinks]!.fromLink)!))];
      this.junctions.push({ node, moves, inLinks, lastActive: 0, lastCount: 0 });
    }
  }

  private setupDemand(): void {
    const zones = this.network.zones;
    const ins = zones.filter((z) => z.role === 'in');
    const outs = zones.filter((z) => z.role === 'out');
    this.destZones = outs.map((z) => ({ zone: z.id, link: this.net.segByLinkId.get(z.link)! }));
    const destIdx = new Map(outs.map((z, i) => [z.id, i]));
    ins.forEach((z, oi) => {
      const rows: { dest: number; rate: number }[] = [];
      for (const r of this.sc.od) {
        if (r.origin !== z.id) continue;
        const d = destIdx.get(r.destination);
        if (d === undefined) throw new Error(`OD destination '${r.destination}' is not an out zone`);
        rows.push({ dest: d, rate: r.rateVph });
      }
      const rate = rows.reduce((acc, r) => acc + r.rate, 0) / 3600;
      const link = this.net.segByLinkId.get(z.link)!;
      const rng = substream(this.sc.seed, Purpose.arrivals, oi);
      for (const r of rows) {
        if (r.rate > 0) this.routeFor(link, this.destZones[r.dest]!.link, z.id, outs[r.dest]!.id);
      }
      this.origins.push({ zone: z.id, link, rate, rng, next: rate > 0 ? rng.exponential(rate) : Infinity, k: 0, rows });
      this.queues.push([]);
    });
    for (const r of this.sc.od) {
      if (!ins.some((z) => z.id === r.origin)) throw new Error(`OD origin '${r.origin}' is not an in zone`);
    }
  }

  private classShares(originZone: string | null): number[] {
    const comp = ((originZone && this.sc.compositionByOrigin?.[originZone]) || this.sc.composition) as Partial<
      Record<VehicleClassId, number>
    >;
    return this.classes.map((c) => comp[c.id] ?? 0);
  }

  private pickClass(u: number, shares: number[]): number {
    let total = 0;
    for (const x of shares) total += x;
    const target = u * total;
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      acc += shares[i]!;
      if (target < acc) return i;
    }
    for (let i = shares.length - 1; i >= 0; i--) if (shares[i]! > 0) return i;
    return 0;
  }

  /** Dijkstra over segments by free-flow time (MODEL.md §2.1). */
  private routeFor(fromLink: number, toLink: number, oz: string, dz: string): number {
    const key = `${fromLink}>${toLink}`;
    const hit = this.routeCache.get(key);
    if (hit !== undefined) return hit;
    const n = this.segs.length;
    const cost = new Float64Array(n).fill(Infinity);
    const hops = new Int32Array(n).fill(0x7fffffff);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    cost[fromLink] = this.segs[fromLink]!.length / this.segs[fromLink]!.speedLimitMps;
    hops[fromLink] = 1;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) {
        if (done[i] || cost[i] === Infinity) continue;
        if (u < 0 || cost[i]! < cost[u]! || (cost[i] === cost[u] && hops[i]! < hops[u]!)) u = i;
      }
      if (u < 0 || u === toLink) break;
      done[u] = 1;
      for (const w of this.segs[u]!.next) {
        const seg = this.segs[w]!;
        const ctl = this.ctrl[w];
        const penalty = ctl === 'signal' ? PENALTY_SIGNAL_S : ctl === 'minor' ? PENALTY_MINOR_S : 0;
        const c = cost[u]! + seg.length / seg.speedLimitMps + penalty;
        if (c < cost[w]! || (c === cost[w] && hops[u]! + 1 < hops[w]!)) {
          cost[w] = c;
          hops[w] = hops[u]! + 1;
          prev[w] = u;
        }
      }
    }
    if (cost[toLink] === Infinity) throw new Error(`no route from zone '${oz}' to zone '${dz}'`);
    const segs: number[] = [];
    for (let x = toLink; x >= 0; x = prev[x]!) segs.unshift(x);
    this.routes.push({ segs, loop: false });
    const idx = this.routes.length - 1;
    this.routeCache.set(key, idx);
    return idx;
  }

  /** Default route (MODEL.md §2.8): follow first outgoing movements to a dead end or a loop. */
  private defaultRoute(linkSeg: number): number {
    const key = `default:${linkSeg}`;
    const hit = this.routeCache.get(key);
    if (hit !== undefined) return hit;
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
    this.routeCache.set(key, this.routes.length - 1);
    return this.routes.length - 1;
  }

  private clearance(cls: VehicleClass, v: number): number {
    return cls.clearance.c0.value + cls.clearance.c1.value * v;
  }

  /** Allocate a slot on a segment. Occupancy (lo/hi) is set by the caller or refreshStrips. */
  private place(
    id: number,
    ci: number,
    length: number,
    width: number,
    drv: { v0: number; T: number; s0: number; a: number; b: number },
    seg: number,
    route: number,
    s: number,
    y: number,
    v: number,
  ): number {
    const st = this.st;
    const k = st.alloc();
    st.id[k] = id;
    st.cls[k] = ci;
    st.seg[k] = seg;
    st.route[k] = route;
    st.rpos[k] = 0;
    st.s[k] = s;
    st.y[k] = y;
    st.ty[k] = y;
    st.v[k] = v;
    st.a[k] = 0;
    st.dy[k] = 0;
    st.len[k] = length;
    st.wid[k] = width;
    st.cOcc[k] = this.clearance(this.classes[ci]!, v);
    st.v0[k] = drv.v0;
    st.T[k] = drv.T;
    st.s0[k] = drv.s0;
    st.am[k] = drv.a;
    st.b[k] = drv.b;
    st.origin[k] = -1;
    st.dest[k] = -1;
    st.tGen[k] = this.t;
    st.tIns[k] = this.t;
    st.tSeg[k] = this.t;
    const cls = this.classes[ci]!;
    const gs = substream(this.sc.seed, Purpose.gap, id);
    st.tc[k] = cls.gap.criticalS.value * (1 + cls.gap.criticalS.spread * gs.uniform(-1, 1));
    st.tf[k] = cls.gap.followUpS.value * (1 + cls.gap.followUpS.spread * gs.uniform(-1, 1));
    st.comply[k] = gs.next() < this.sc.boxCompliance ? 1 : 0;
    st.stuck[k] = 0;
    st.diverted[k] = 0;
    st.ffTrav[k] = 0;
    if (length > this.maxLen) this.maxLen = length;
    this.insertOcc(seg, k);
    this.stats[seg]!.entered++;
    this.generated++;
    const [lo, hi] = this.spanOf(k, this.segs[seg]!, y, y);
    st.lo[k] = lo;
    st.hi[k] = hi;
    return k;
  }

  private insertOcc(seg: number, k: number): void {
    const list = this.occ[seg]!;
    const { s, id } = this.st;
    let i = list.length;
    while (i > 0 && (s[list[i - 1]!]! > s[k]! || (s[list[i - 1]!]! === s[k]! && id[list[i - 1]!]! > id[k]!))) i--;
    list.splice(i, 0, k);
  }

  private drawDriver(id: number, cls: VehicleClass) {
    const ds = substream(this.sc.seed, Purpose.driver, id);
    const m = (p: { value: number; spread: number }) => p.value * (1 + p.spread * ds.uniform(-1, 1));
    return { v0: m(cls.idm.v0), T: m(cls.idm.T), s0: m(cls.idm.s0), a: m(cls.idm.a), b: m(cls.idm.b) };
  }

  private placeInitial(): void {
    const dens = this.sc.initialDensityPerKm;
    if (dens <= 0) return;
    const jitter = this.sc.initialJitterM;
    const init = substream(this.sc.seed, Purpose.init, 0);
    let nextId = INIT_ID_BASE;
    const shares = this.classShares(null);
    for (let li = 0; li < this.net.nLinks; li++) {
      const seg = this.segs[li]!;
      const L = seg.length;
      const n = Math.floor((dens * L) / 1000 + 0.5);
      if (n === 0) continue;
      const routeIdx = this.defaultRoute(li);
      const loop = this.routes[routeIdx]!.loop;
      const lanes = this.network.links[li]!.lanes;
      const laneW = seg.widthM / lanes;
      for (let k = 0; k < n; k++) {
        let s = ((k + 0.5) * L) / n + init.uniform(-jitter, jitter);
        if (loop) s = s - Math.floor(s / L) * L;
        else s = Math.min(Math.max(s, 0), L);
        const id = nextId++;
        const vs = substream(this.sc.seed, Purpose.vehicle, id);
        const ci = this.pickClass(vs.next(), shares);
        const cls = this.classes[ci]!;
        const length = sampleDist(cls.lengthM, vs.next());
        const width = sampleDist(cls.widthM, vs.next());
        const y = (k % lanes) * laneW + laneW / 2;
        this.place(id, ci, length, width, this.drawDriver(id, cls), li, routeIdx, s, y, 0);
      }
    }
  }

  /* ================= occupancy and leader search ================= */

  /** Occupied strips on `seg` for vehicle k with centre y moving to target ty (§1.5, §2.4). */
  private spanOf(k: number, seg: Segment, y: number, ty: number): [number, number] {
    const lay = seg.layout;
    if (this.lane) {
      const a = laneStrip(y, lay);
      const b = laneStrip(ty, lay);
      return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
    }
    const st = this.st;
    if (y === ty) return occupiedStrips(y, st.wid[k]!, st.cOcc[k]!, lay);
    return sweptStrips(y, ty, st.wid[k]!, st.cOcc[k]!, lay);
  }

  private spanAt(width: number, c: number, seg: Segment, y: number): [number, number] {
    return this.lane ? laneStrip(y, seg.layout) : occupiedStrips(y, width, c, seg.layout);
  }

  private refreshStrips(): void {
    const st = this.st;
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const [lo, hi] = this.spanOf(k, this.segs[st.seg[k]!]!, st.y[k]!, st.ty[k]!);
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
   * Leader by the §1.6 rule: nearest rear end among strip-overlapping vehicles ahead, along the
   * route, with the lane-band rule (§2.2) and look-ahead cap D. `self` is excluded (−1 for a
   * hypothetical vehicle), as is `skip`.
   */
  private leader(
    self: number,
    skip: number,
    seg0: Segment,
    s: number,
    selfId: number,
    y: number,
    lo: number,
    hi: number,
    width: number,
    c: number,
    route: Route,
    rpos0: number,
    D: number,
  ): Leader {
    const st = this.st;
    const maxLen = this.maxLen;
    let bestRear = Infinity;
    let bestId = Infinity;
    let vl = 0;
    let slot = -1;
    const upd = (rear: number, v: number, j: number, id: number) => {
      if (rear < bestRear || (rear === bestRear && id < bestId)) {
        bestRear = rear;
        bestId = id;
        vl = v;
        slot = j;
      }
    };
    const own = this.occ[seg0.index]!;
    // First own-segment occupant ahead of (s, selfId): binary search on the sorted list.
    let a = 0;
    let b = own.length;
    while (a < b) {
      const m = (a + b) >> 1;
      const j = own[m]!;
      if (st.s[j]! < s || (st.s[j] === s && st.id[j]! <= selfId)) a = m + 1;
      else b = m;
    }
    for (let m = a; m < own.length; m++) {
      const j = own[m]!;
      const off = st.s[j]! - s;
      if (off - maxLen > bestRear) break;
      if (j === self || j === skip) continue;
      if (st.lo[j]! > hi || lo > st.hi[j]!) continue;
      const rear = off - st.len[j]!;
      if (rear < bestRear || (rear === bestRear && st.id[j]! < bestId)) {
        bestRear = rear;
        bestId = st.id[j]!;
        vl = st.v[j]!;
        slot = j;
      }
    }
    if (seg0.kind === 'movement') this.junctionCands(self, skip, seg0, -s, y, width, c, selfId, upd);
    let seg = seg0;
    let rpos = rpos0;
    let off = seg.length - s;
    let yy = y;
    while (off - maxLen < bestRear && off < D) {
      const nx = this.nextSeg(route, rpos);
      if (!nx) break;
      const nseg = this.segs[nx.seg]!;
      if (seg.kind === 'link' && nseg.kind === 'movement') {
        const half = width / 2;
        const band = effBand(nseg);
        if (yy - half < band[0] - EPS || yy + half > band[1] + EPS) {
          // Lane-band rule: the link end is a standing obstacle.
          if (off < bestRear) {
            bestRear = off;
            vl = 0;
            slot = -1;
          }
          break;
        }
        // Junction stop line: signal, gap acceptance, don't block the box (§3.4).
        if (self >= 0 && this.stopBlocked(self, nseg, off)) {
          if (off < bestRear) {
            bestRear = off;
            vl = 0;
            slot = -1;
          }
          break;
        }
      }
      yy = mapLateral(seg, nseg, yy);
      const [nlo, nhi] = this.spanAt(width, c, nseg, yy);
      const list = this.occ[nseg.index]!;
      for (let m = 0; m < list.length; m++) {
        const j = list[m]!;
        const fo = off + st.s[j]!;
        if (fo - maxLen > bestRear) break;
        if (j === self || j === skip) continue;
        if (st.lo[j]! > nhi || nlo > st.hi[j]!) continue;
        const rear = fo - st.len[j]!;
        if (rear < bestRear || (rear === bestRear && st.id[j]! < bestId)) {
          bestRear = rear;
          bestId = st.id[j]!;
          vl = st.v[j]!;
          slot = j;
        }
      }
      if (nseg.kind === 'movement') this.junctionCands(self, skip, nseg, off, yy, width, c, selfId, upd);
      off += nseg.length;
      rpos = nx.rpos;
      seg = nseg;
    }
    if (bestRear > D) return { gap: Infinity, vl: 0, slot: -1 };
    return { gap: bestRear, vl, slot };
  }

  /** Does movement `m` yield to movement `o` right now (§3.4 rule 2)? */
  private yields(m: number, o: number): boolean {
    const cm = this.ctrl[m];
    const co = this.ctrl[o];
    if (co === 'free' && cm !== 'free') return true;
    const sm = this.sigNow[m]!;
    const so = this.sigNow[o]!;
    if (sm !== SIG.NONE || so !== SIG.NONE) return sm === SIG.PERMISSIVE && so === SIG.GREEN;
    return cm === 'minor' && co === 'major';
  }

  private fromLinkOf(movementSeg: number): Segment {
    return this.segs[this.net.segByLinkId.get(this.network.movements[movementSeg - this.net.nLinks]!.fromLink)!]!;
  }

  /**
   * Is vehicle k (front `off` metres before the start of movement m) held at its stop line?
   * Signal state, gap acceptance against higher-priority streams, don't block the box.
   */
  private stopBlocked(k: number, m: Segment, off: number): boolean {
    const st = this.st;
    const v = st.v[k]!;
    const b = st.b[k]!;
    const sig = this.sigNow[m.index]!;
    if (sig === SIG.RED) {
      this.holds.red++;
      return true;
    }
    if (sig === SIG.AMBER && off >= (v * v) / (2 * b)) {
      this.holds.amber++;
      return true;
    }
    const zone = Math.max((v * v) / (2 * b), 2) + v * this.dt;
    if (off > zone) return false;
    // Gap acceptance (§3.3): every yielding crossing/merging conflict must accept.
    const since = this.t - this.lastEntry[m.index]!;
    for (const cf of this.conf[m.index]!) {
      if (cf.type === 'diverging' || !this.yields(m.index, cf.other)) continue;
      const o = this.segs[cf.other]!;
      let next = Infinity;
      for (const j of this.occ[o.index]!) {
        if (st.s[j]! - st.len[j]! >= cf.oth[1]) continue; // already past the conflict
        const d = cf.oth[0] - st.s[j]! > 0 ? cf.oth[0] - st.s[j]! : 0;
        const tj = d / (st.v[j]! > 0.5 ? st.v[j]! : 0.5);
        if (tj < next) next = tj;
      }
      const from = this.fromLinkOf(o.index);
      const list = this.occ[from.index]!;
      for (let q = list.length - 1; q >= 0; q--) {
        const j = list[q]!;
        const toEnd = from.length - st.s[j]!;
        if (toEnd > 150) break;
        const nx = this.nextSeg(this.routes[st.route[j]!]!, st.rpos[j]!);
        if (!nx || nx.seg !== o.index) continue;
        const tj = (toEnd + cf.oth[0]) / (st.v[j]! > 0.5 ? st.v[j]! : 0.5);
        if (tj < next) next = tj;
      }
      if (!acceptGap(next, since, st.tc[k]!, st.tf[k]!)) {
        this.holds.gap++;
        return true;
      }
    }
    // Don't block the box (junction nodes only).
    if (this.isJunctionMove[m.index] && st.comply[k]) {
      // Space beyond the box, measured along k's route from the start of m's toLink and
      // continuing across short segments (OSM networks have exit links shorter than a car).
      const need = st.len[k]! + st.s0[k]!;
      const route = this.routes[st.route[k]!]!;
      let rp = st.rpos[k]! + 1; // m
      let acc = 0;
      let space = Infinity;
      for (;;) {
        const nx = this.nextSeg(route, rp);
        if (!nx) break;
        rp = nx.rpos;
        const seg = this.segs[nx.seg]!;
        let nearest = Infinity;
        for (const j of this.occ[seg.index]!) {
          if (st.v[j]! >= BOX_QUEUE_SPEED) continue; // moving traffic is car-following's job
          const r = st.s[j]! - st.len[j]!;
          if (r < nearest) nearest = r;
        }
        if (nearest !== Infinity) {
          space = acc + nearest;
          break;
        }
        acc += seg.length;
        if (acc >= need) break;
      }
      if (space < need) {
        this.holds.box++;
        return true;
      }
    }
    return false;
  }

  /**
   * Junction candidates on movement m for a vehicle whose front is `off` before m's start:
   * occupied crossing areas become standing obstacles; vehicles on merging movements are
   * projected by distance to the end, on diverging movements by distance from the start.
   */
  private junctionCands(
    self: number,
    skip: number,
    m: Segment,
    off: number,
    ym: number,
    width: number,
    c: number,
    selfId: number,
    upd: (rear: number, v: number, j: number, id: number) => void,
  ): void {
    const st = this.st;
    const myPos = -off;
    for (const cf of this.conf[m.index]!) {
      const o = this.segs[cf.other]!;
      if (cf.type === 'crossing') {
        if (myPos >= cf.self[0] - EPS) continue; // already in the area: committed
        for (const j of this.occ[o.index]!) {
          if (j === self || j === skip) continue;
          if (st.s[j]! >= cf.oth[0] && st.s[j]! - st.len[j]! <= cf.oth[1]) {
            upd(off + cf.self[0], 0, -1, -1);
            this.holds.occupied++;
            break;
          }
        }
      } else if (cf.type === 'merging') {
        const to = this.segs[m.next[0]!]!;
        const [lo, hi] = this.spanAt(width, c, to, mapLateral(m, to, ym));
        const consider = (j: number, distToEnd: number, yTo: number) => {
          if (j === self || j === skip) return;
          const front = off + m.length - distToEnd;
          if (!(front > 0 || (front === 0 && st.id[j]! < selfId))) return;
          const [jl, jh] = this.spanAt(st.wid[j]!, st.cOcc[j]!, to, yTo);
          if (jl > hi || lo > jh) return;
          upd(front - st.len[j]!, st.v[j]!, j, st.id[j]!);
        };
        for (const j of this.occ[o.index]!) consider(j, o.length - st.s[j]!, mapLateral(o, to, st.y[j]!));
        // Vehicles still approaching m′ count only if they will actually enter it: m′ not held
        // by a red/amber signal, m′ not yielding to m, and the vehicle moving.
        const so = this.sigNow[o.index]!;
        const willEnter = so !== SIG.RED && so !== SIG.AMBER && !this.yields(o.index, m.index);
        const fromO = this.fromLinkOf(o.index);
        const list = willEnter ? this.occ[fromO.index]! : [];
        for (let q = list.length - 1; q >= 0; q--) {
          const j = list[q]!;
          const toEnd = fromO.length - st.s[j]!;
          if (toEnd > 60) break;
          const nx = this.nextSeg(this.routes[st.route[j]!]!, st.rpos[j]!);
          if (!nx || nx.seg !== o.index || st.v[j]! <= 0.5) continue;
          consider(j, toEnd + o.length, mapLateral(o, to, mapLateral(fromO, o, st.y[j]!)));
        }
      } else {
        const from = this.fromLinkOf(m.index);
        const [lo, hi] = this.spanAt(width, c, from, ym + m.fromLateral[0]);
        for (const j of this.occ[o.index]!) {
          if (j === self || j === skip) continue;
          if (st.s[j]! - st.len[j]! >= cf.oth[1]) continue;
          const front = off + st.s[j]!;
          if (!(front > 0)) continue;
          const [jl, jh] = this.spanAt(st.wid[j]!, st.cOcc[j]!, from, st.y[j]! + o.fromLateral[0]);
          if (jl > hi || lo > jh) continue;
          upd(front - st.len[j]!, st.v[j]!, j, st.id[j]!);
        }
      }
    }
  }

  private lookahead(v: number, b: number): number {
    return Math.max(150, (v * v) / (2 * b) + 50);
  }

  private leaderOfSlot(k: number, lo: number, hi: number, y: number, skip = -1): Leader {
    const st = this.st;
    return this.leader(
      k,
      skip,
      this.segs[st.seg[k]!]!,
      st.s[k]!,
      st.id[k]!,
      y,
      lo,
      hi,
      st.wid[k]!,
      st.cOcc[k]!,
      this.routes[st.route[k]!]!,
      st.rpos[k]!,
      this.lookahead(st.v[k]!, st.b[k]!),
    );
  }

  private idm(k: number, v: number, gap: number, vl: number): number {
    const st = this.st;
    const seg = this.segs[st.seg[k]!]!;
    P.v0 = Math.min(st.v0[k]!, seg.speedLimitMps);
    P.T = st.T[k]!;
    P.s0 = st.s0[k]!;
    P.a = st.am[k]!;
    P.b = st.b[k]!;
    return idmAccel(P, v, gap, v - vl);
  }

  /**
   * Deadlock breaker (§2.2): a vehicle stopped at the end of a link because its body is outside
   * the next movement's band, for REROUTE_AFTER_S, takes the movement whose band it fits best and
   * is rerouted to its destination from there (or, if unreachable, to the nearest exit: a
   * diverted trip). Swap deadlocks at diverges otherwise never resolve.
   */
  private breakBandDeadlocks(): void {
    const st = this.st;
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const seg = this.segs[st.seg[k]!]!;
      const route = this.routes[st.route[k]!]!;
      const nx = seg.kind === 'link' ? this.nextSeg(route, st.rpos[k]!) : null;
      const m = nx ? this.segs[nx.seg]! : null;
      const half = st.wid[k]! / 2;
      const y = st.y[k]!;
      const outside = (mv: Segment) => {
        const b = effBand(mv);
        return Math.max(0, b[0] - (y - half)) + Math.max(0, y + half - b[1]);
      };
      const atEnd = m !== null && m.kind === 'movement' && seg.length - st.s[k]! < st.s0[k]! + 1 && st.v[k]! < 0.1 && outside(m) > EPS;
      if (!atEnd) {
        st.stuck[k] = 0;
        continue;
      }
      st.stuck[k] = st.stuck[k]! + this.dt;
      if (st.stuck[k]! < REROUTE_AFTER_S) continue;
      // Best-fitting alternative movement from this link.
      let best = -1;
      let bestOut = Infinity;
      for (const g of seg.next) {
        if (g === m!.index) continue;
        const o = outside(this.segs[g]!);
        if (o < bestOut - EPS || (Math.abs(o - bestOut) <= EPS && g < best)) {
          bestOut = o;
          best = g;
        }
      }
      if (best < 0 || bestOut >= outside(m!) - EPS) continue;
      const to = this.segs[best]!.next[0]!;
      let tail: number[] | null = null;
      if (st.dest[k]! >= 0) {
        try {
          const d = this.destZones[st.dest[k]!]!;
          tail = this.routes[this.routeFor(to, d.link, '(reroute)', d.zone)]!.segs;
        } catch {
          tail = null;
        }
      }
      if (!tail) {
        // Nearest reachable exit (diverted trip) or, for vehicles without a destination, the default route.
        let bestCost = Infinity;
        for (const d of this.destZones) {
          try {
            const r = this.routes[this.routeFor(to, d.link, '(reroute)', d.zone)]!.segs;
            let c = 0;
            for (const g of r) c += this.segs[g]!.length;
            if (c < bestCost) {
              bestCost = c;
              tail = r;
            }
          } catch {
            /* unreachable exit */
          }
        }
        if (!tail) tail = this.routes[this.defaultRoute(to)]!.segs;
        if (st.dest[k]! >= 0) {
          st.diverted[k] = 1;
          this.diversions++;
        }
      }
      this.routes.push({ segs: [seg.index, best, ...tail], loop: false });
      st.route[k] = this.routes.length - 1;
      st.rpos[k] = 0;
      st.stuck[k] = 0;
      this.reroutes++;
    }
  }

  /** Distance vehicle k can cover in one step from the snapshot, plus a 0.1 m margin. */
  private gapFloor(k: number): number {
    const st = this.st;
    const a = st.a[k]! > 0 ? st.a[k]! : 0;
    const kin = st.v[k]! * this.dt + 0.5 * a * this.dt * this.dt + 0.1;
    const half = 0.5 * st.s0[k]!;
    return kin > half ? kin : half;
  }

  /** Band of the movement that follows k's current link on its route, or null. */
  private nextBand(k: number): [number, number] | null {
    const st = this.st;
    const seg = this.segs[st.seg[k]!]!;
    if (seg.kind !== 'link') return null;
    const nx = this.nextSeg(this.routes[st.route[k]!]!, st.rpos[k]!);
    if (!nx) return null;
    const ns = this.segs[nx.seg]!;
    return ns.kind === 'movement' ? effBand(ns) : null;
  }

  /* ================= lateral decisions (§2.4) ================= */

  /** Nearest follower behind k on its link overlapping [lo, hi] (largest front; ties larger id). */
  private follower(k: number, pos: number, lo: number, hi: number): number {
    const st = this.st;
    const list = this.occ[st.seg[k]!]!;
    for (let m = pos - 1; m >= 0; m--) {
      const j = list[m]!;
      if (st.lo[j]! > hi || lo > st.hi[j]!) continue;
      return j;
    }
    return -1;
  }

  /**
   * Vehicles on predecessor segments whose bodies reach past the start of k's segment, with
   * their fronts and strip spans expressed in k's segment (negative front offsets).
   */
  private upstream(k: number): { j: number; front: number; lo: number; hi: number }[] {
    const st = this.st;
    const seg = this.segs[st.seg[k]!]!;
    const out: { j: number; front: number; lo: number; hi: number }[] = [];
    const reach = st.len[k]! + this.maxLen;
    for (const pg of this.preds[seg.index]!) {
      const pseg = this.segs[pg]!;
      const list = this.occ[pg]!;
      for (let m = list.length - 1; m >= 0; m--) {
        const j = list[m]!;
        const front = st.s[j]! - pseg.length;
        if (front < -reach) break;
        if (j === k) continue;
        const yj = mapLateral(pseg, seg, st.y[j]!);
        const tyj = mapLateral(pseg, seg, st.ty[j]!);
        let lo: number;
        let hi: number;
        if (this.lane) {
          const a = laneStrip(yj, seg.layout);
          const b = laneStrip(tyj, seg.layout);
          lo = Math.min(a[0], b[0]);
          hi = Math.max(a[1], b[1]);
        } else {
          [lo, hi] = sweptStrips(yj, tyj, st.wid[j]!, st.cOcc[j]!, seg.layout);
        }
        out.push({ j, front, lo, hi });
      }
    }
    return out;
  }

  private decide(k: number, pos: number): Decision | null {
    const st = this.st;
    const seg = this.segs[st.seg[k]!]!;
    if (seg.kind !== 'link') return null;
    const y = st.y[k]!;
    if (y !== st.ty[k]!) return null;
    const cls = this.classes[st.cls[k]!]!;
    const v = st.v[k]!;
    const W = seg.widthM;
    const width = st.wid[k]!;
    const cNow = this.clearance(cls, v);
    const h = width / 2 + cNow;
    const cands: number[] = [];
    if (this.lane) {
      const lw = seg.layout.w;
      for (const yc of [y - lw, y + lw]) if (yc > 0 && yc < W) cands.push(yc);
    } else {
      const w = seg.layout.w;
      const J = Math.max(1, Math.floor((cls.lateral.maxSpeedMps.value * TAU_REACH_S) / w));
      // A vehicle that does not fit its road (e.g. after entering a narrower segment) may make
      // any move that reduces the overflow, even if the result still does not fully fit (§2.4).
      const over = (yy: number) => Math.max(0, h - yy) + Math.max(0, yy + h - W);
      const overNow = over(y);
      // Band-seeking moves (towards the next movement's band) need only the body inside the
      // road: edge clearance yields when the band requires it (wide vehicle, narrow movement).
      const nb = this.nextBand(k);
      const bandDist = (yy: number) => (nb ? Math.max(0, nb[0] - (yy - width / 2)) + Math.max(0, yy + width / 2 - nb[1]) : 0);
      const dNow = bandDist(y);
      for (let j = -J; j <= J; j++) {
        if (j === 0) continue;
        const yc = y + j * w;
        const fits = yc - h >= -EPS && yc + h <= W + EPS;
        const seeksBand = dNow > 0 && bandDist(yc) < dNow - EPS && yc - width / 2 >= -EPS && yc + width / 2 <= W + EPS;
        if (fits || seeksBand || over(yc) < overNow - EPS) cands.push(yc);
      }
    }
    if (cands.length === 0) return null;

    // Route bias (band of the next movement).
    const route = this.routes[st.route[k]!]!;
    const nx = this.nextSeg(route, st.rpos[k]!);
    const band = nx && this.segs[nx.seg]!.kind === 'movement' ? effBand(this.segs[nx.seg]!) : null;
    const dEnd = seg.length - st.s[k]!;
    const dist = (yy: number) =>
      band ? Math.max(0, band[0] - (yy - width / 2)) + Math.max(0, yy + width / 2 - band[1]) : 0;
    const beta = Math.min(1, 200 / Math.max(dEnd, 1));
    const distNow = dist(y);
    const threshold = distNow > 0 && dEnd < WAIVER_M ? 0 : cls.lateral.thresholdMps2.value;
    const p = cls.lateral.politeness.value;

    const aC = st.a[k]!;
    const front = st.s[k]!;
    const rear = front - st.len[k]!;
    // Old follower O (current span) and its acceleration without k.
    // Followers may sit on predecessor segments when k is near its segment start.
    const ups = this.upstream(k);
    const upFollower = (lo: number, hi: number): { j: number; front: number } | null => {
      let best: { j: number; front: number } | null = null;
      for (const u of ups) {
        if (u.lo > hi || lo > u.hi) continue;
        if (!best || u.front > best.front || (u.front === best.front && st.id[u.j]! > st.id[best.j]!)) best = u;
      }
      return best;
    };
    let O = this.follower(k, pos, st.lo[k]!, st.hi[k]!);
    if (O < 0) O = upFollower(st.lo[k]!, st.hi[k]!)?.j ?? -1;
    let dO = 0;
    if (O >= 0) {
      const lO = this.leaderOfSlot(O, st.lo[O]!, st.hi[O]!, st.y[O]!, k);
      dO = this.idm(O, st.v[O]!, lO.gap, lO.vl) - st.a[O]!;
    }
    let best: Decision | null = null;
    let bestDelta = -Infinity;
    let bestAbsJ = Infinity;
    const list = this.occ[seg.index]!;
    for (const yc of cands) {
      if (distNow === 0 && dist(yc) > 0) continue; // band keeping (§2.4)
      const [tlo, thi] = this.spanAt(width, this.lane ? 0 : cNow, seg, yc);
      const sw = this.lane
        ? ([Math.min(st.lo[k]!, tlo), Math.max(st.hi[k]!, thi)] as [number, number])
        : sweptStrips(y, yc, width, cNow, seg.layout);
      // Safety 3: nothing overlapping the swept span overlaps k longitudinally.
      let clash = false;
      // List is sorted by front: scan forward until no rear can reach `front`, back until fronts
      // fall to `rear`.
      for (let m = pos + 1; m < list.length && !clash; m++) {
        const j = list[m]!;
        if (st.s[j]! - this.maxLen >= front) break;
        if (st.lo[j]! > sw[1] || sw[0] > st.hi[j]!) continue;
        if (st.s[j]! - st.len[j]! < front) clash = true;
      }
      for (let m = pos - 1; m >= 0 && !clash; m--) {
        const j = list[m]!;
        if (st.s[j]! <= rear) break;
        if (st.lo[j]! > sw[1] || sw[0] > st.hi[j]!) continue;
        clash = true;
      }
      for (const u of ups) {
        if (clash) break;
        if (u.front > rear && !(u.lo > sw[1] || sw[0] > u.hi)) clash = true;
      }
      if (clash) continue;
      const L = this.leader(k, -1, seg, front, st.id[k]!, yc, tlo, thi, width, cNow, route, st.rpos[k]!, this.lookahead(v, st.b[k]!));
      // A standing obstacle (link end, stop line) does not move: edging sideways in front of it
      // is safe, so the vehicle-oriented checks below apply only to vehicle leaders (§2.4).
      const obstacle = L.slot < 0 && L.gap !== Infinity;
      if (!obstacle && !(L.gap > 0 && L.gap >= this.gapFloor(k))) continue; // kinematic gap floor
      const aTilde = this.idm(k, v, L.gap, L.vl);
      // Self-safety (MODEL.md §2.4): the mover must not need to brake harder than B_SAFE.
      if (!obstacle && aTilde < -B_SAFE) continue;
      let N = this.follower(k, pos, tlo, thi);
      let nFront = N >= 0 ? st.s[N]! : 0;
      if (N < 0) {
        const u = upFollower(tlo, thi);
        if (u) {
          N = u.j;
          nFront = u.front;
        }
      }
      let dN = 0;
      // A new follower that already follows k in its current span keeps the same leader and gap:
      // the move changes nothing for it, so neither its safety checks nor its gain apply (§2.4).
      const sameFollower = N >= 0 && N === O;
      if (N >= 0 && !sameFollower) {
        const gN = rear - nFront;
        if (!(gN > 0 && gN >= this.gapFloor(N))) continue; // kinematic gap floor (§2.4)
        const aN = this.idm(N, st.v[N]!, gN, v);
        if (aN < -B_SAFE) continue;
        dN = aN - st.a[N]!;
      }
      const delta = aTilde - aC + p * (dN + (O >= 0 && !sameFollower ? dO : 0)) + beta * (distNow - dist(yc));
      if (!(delta > threshold)) continue;
      const absJ = Math.abs(yc - y);
      if (delta > bestDelta || (delta === bestDelta && (absJ < bestAbsJ - EPS || (Math.abs(absJ - bestAbsJ) <= EPS && yc < best!.target)))) {
        bestDelta = delta;
        bestAbsJ = absJ;
        best = { k, target: yc, lo: sw[0], hi: sw[1] };
      }
    }
    return best;
  }

  private commitDecisions(decisions: Decision[]): void {
    const st = this.st;
    decisions.sort((d1, d2) => st.s[d2.k]! - st.s[d1.k]! || st.id[d1.k]! - st.id[d2.k]!);
    const committed: Decision[] = [];
    for (const d of decisions) {
      const k = d.k;
      const fi = st.s[k]!;
      const ri = fi - st.len[k]!;
      const s0 = st.s0[k]!;
      let ok = true;
      for (const c of committed) {
        if (st.seg[c.k] !== st.seg[k]) continue;
        if (c.lo > d.hi || d.lo > c.hi) continue;
        const fj = st.s[c.k]! + s0;
        const rj = st.s[c.k]! - st.len[c.k]! - s0;
        if (rj < fi && fj > ri) {
          ok = false;
          break;
        }
        // Safety against moves committed earlier this step (MODEL.md §2.4): the same B_SAFE
        // criteria as the decision, applied to the new pair.
        const j = c.k;
        if (st.s[j]! > fi) {
          const gap = st.s[j]! - st.len[j]! - fi;
          if (!(gap > 0 && gap >= this.gapFloor(k)) || this.idm(k, st.v[k]!, gap, st.v[j]!) < -B_SAFE) ok = false;
        } else {
          const gap = ri - st.s[j]!;
          if (!(gap > 0 && gap >= this.gapFloor(j)) || this.idm(j, st.v[j]!, gap, st.v[k]!) < -B_SAFE) ok = false;
        }
        if (!ok) break;
      }
      if (!ok) continue;
      committed.push(d);
      st.ty[k] = d.target;
      st.cOcc[k] = this.clearance(this.classes[st.cls[k]!]!, st.v[k]!);
    }
  }

  /* ================= stepping ================= */

  advance(steps = 1): void {
    for (let n = 0; n < steps; n++) this.stepOnce();
  }

  private stepOnce(): void {
    const st = this.st;
    const dt = this.dt;
    for (let g = this.net.nLinks; g < this.segs.length; g++) {
      const pl = this.plan[g];
      this.sigNow[g] = pl ? signalState(pl, this.segs[g]!.id, this.t) : SIG.NONE;
    }
    this.activeThisStep = false;
    this.breakBandDeadlocks();
    // 1. Snapshot accelerations.
    for (const list of this.occ) {
      for (let m = 0; m < list.length; m++) {
        const k = list[m]!;
        const L = this.leaderOfSlot(k, st.lo[k]!, st.hi[k]!, st.y[k]!);
        st.a[k] = this.idm(k, st.v[k]!, L.gap, L.vl);
        st.lead[k] = L.slot;
        st.leadGap[k] = L.gap;
      }
    }
    // 2–3. Lateral decisions from the same snapshot, then deterministic commit.
    const decisions: Decision[] = [];
    for (let g = 0; g < this.net.nLinks; g++) {
      const list = this.occ[g]!;
      for (let m = 0; m < list.length; m++) {
        const d = this.decide(list[m]!, m);
        if (d) decisions.push(d);
      }
    }
    if (decisions.length) this.commitDecisions(decisions);
    // Lateral step size from the snapshot speed.
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const diff = st.ty[k]! - st.y[k]!;
      if (diff === 0) {
        st.dy[k] = 0;
        continue;
      }
      let vLat: number;
      if (this.lane) {
        const seg = this.segs[st.seg[k]!]!;
        vLat = seg.layout.w / LANE_CHANGE_S;
      } else {
        const v = st.v[k]!;
        vLat = this.classes[st.cls[k]!]!.lateral.maxSpeedMps.value * Math.min(1, 0.25 + v / 4);
      }
      const stepMax = vLat * dt;
      st.dy[k] = Math.abs(diff) <= stepMax ? diff : diff > 0 ? stepMax : -stepMax;
    }
    // 4. Longitudinal integration, then the collision guard (MODEL.md §1.4).
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      const r = ballistic(st.s[k]!, st.v[k]!, st.a[k]!, dt);
      st.ds[k] = r.x - st.s[k]!;
      st.v[k] = r.v;
    }
    this.collisionGuard();
    // 5. Apply displacement and lateral motion.
    for (let k = 0; k < st.cap; k++) {
      if (!st.alive[k]) continue;
      st.s[k] = st.s[k]! + st.ds[k]!;
      const lim = this.segs[st.seg[k]!]!.speedLimitMps;
      st.ffTrav[k] = st.ffTrav[k]! + st.ds[k]! / Math.min(st.v0[k]!, lim);
      if (st.dy[k] !== 0) {
        const ny = st.y[k]! + st.dy[k]!;
        st.y[k] = Math.abs(st.ty[k]! - ny) <= EPS ? st.ty[k]! : ny;
      }
    }
    const tNew = (this.step + 1) * dt;
    // 6. Transfer across segment ends; exits.
    const moved: number[] = [];
    for (let g = 0; g < this.occ.length; g++) {
      const list = this.occ[g]!;
      for (let m = list.length - 1; m >= 0; m--) {
        const k = list[m]!;
        let seg = this.segs[st.seg[k]!]!;
        if (st.s[k]! < seg.length) continue;
        list.splice(m, 1);
        const route = this.routes[st.route[k]!]!;
        let gone = false;
        while (st.s[k]! >= seg.length) {
          const stat = this.stats[seg.index]!;
          stat.exited++;
          stat.travelTimeSum += tNew - st.tSeg[k]!;
          stat.travelTimeCount++;
          const nx = this.nextSeg(route, st.rpos[k]!);
          if (!nx) {
            gone = true;
            break;
          }
          st.s[k] = st.s[k]! - seg.length;
          const nseg = this.segs[nx.seg]!;
          st.y[k] = mapLateral(seg, nseg, st.y[k]!);
          st.ty[k] = mapLateral(seg, nseg, st.ty[k]!);
          st.seg[k] = nx.seg;
          st.rpos[k] = nx.rpos;
          st.tSeg[k] = tNew;
          this.stats[nx.seg]!.entered++;
          if (nseg.kind === 'movement') {
            this.lastEntry[nx.seg] = tNew;
            if (this.isJunctionMove[nx.seg]) this.activeThisStep = true;
          }
          if (seg.kind === 'movement' && this.isJunctionMove[seg.index]) this.activeThisStep = true;
          seg = nseg;
        }
        if (gone) this.exit(k, tNew);
        else moved.push(k);
      }
    }
    for (const k of moved) this.occ[st.seg[k]!]!.push(k);
    for (const list of this.occ) this.sortOcc(list);
    this.t = tNew;
    this.step++;
    this.refreshStrips();
    // 7. Generation and insertion.
    this.generate(tNew);
    this.insertQueued();
    // Metrics after the step.
    for (let g = 0; g < this.occ.length; g++) this.stats[g]!.vehicleSeconds += this.occ[g]!.length * dt;
    this.trackGridlock(tNew);
    this.vehicleSteps += st.count; // vehicles on the network after the step (§5.2)
    this.sampleSeries();
  }

  /**
   * Kinematic collision guard: a front may not pass its snapshot leader's new rear (or a standing
   * obstacle). IDM is collision-free only while leaders brake within their limits; in dense
   * cut-in traffic that can fail by a few centimetres. When the guard binds, displacement is
   * capped and speed is limited to the leader's. Activations are counted (diagnostics()).
   */
  private collisionGuard(): void {
    const st = this.st;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let g = 0; g < this.occ.length; g++) {
        const list = this.occ[g]!;
        for (let m = list.length - 1; m >= 0; m--) {
          const k = list[m]!;
          const gap = st.leadGap[k]!;
          if (gap === Infinity) continue;
          const j = st.lead[k]!;
          const allowed = j >= 0 ? gap + st.ds[j]! - GUARD_GAP_M : gap - GUARD_GAP_M;
          const capped = allowed > 0 ? allowed : 0;
          if (st.ds[k]! <= capped + 1e-12) continue; // no real reduction: not an activation
          st.ds[k] = capped;
          const vCap = j >= 0 ? st.v[j]! : 0;
          if (st.v[k]! > vCap) st.v[k] = vCap;
          this.guardHits++;
          this.guardBySeg[st.seg[k]!] = (this.guardBySeg[st.seg[k]!] ?? 0) + 1;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  /** Engine diagnostics: how often the collision guard had to bind, out of all vehicle-steps. */
  diagnostics(): { guardActivations: number; vehicleSteps: number; holds: Record<string, number>; reroutes: number; diversions: number } {
    return { guardActivations: this.guardHits, vehicleSteps: this.vehicleSteps, holds: { ...this.holds }, reroutes: this.reroutes, diversions: this.diversions };
  }

  /** Update stall clocks (§3.4 item 6): per junction region and for the whole network. */
  private trackGridlock(t: number): void {
    const st = this.st;
    let moving = st.count === 0;
    for (let k = 0; k < st.cap && !moving; k++) if (st.alive[k] && st.v[k]! > 0.1) moving = true;
    const flowed = this.genSeen !== this.exited + this.insertedTotal;
    this.genSeen = this.exited + this.insertedTotal;
    if (moving || flowed) this.netLastActive = t;
    for (const J of this.junctions) {
      let count = 0;
      for (const g of J.moves) count += this.stats[g]!.entered + this.stats[g]!.exited;
      let active = count !== J.lastCount;
      J.lastCount = count;
      let occupied = false;
      if (!active) {
        for (const g of J.moves) {
          for (const k of this.occ[g]!) {
            occupied = true;
            if (st.v[k]! > 0.1) active = true;
          }
        }
        for (const g of J.inLinks) {
          const seg = this.segs[g]!;
          const list = this.occ[g]!;
          for (let q = list.length - 1; q >= 0; q--) {
            const k = list[q]!;
            if (seg.length - st.s[k]! > REGION_M) break;
            occupied = true;
            if (st.v[k]! > 0.1) active = true;
          }
        }
      }
      if (active || !occupied) J.lastActive = t;
    }
  }

  gridlock(): GridlockReport | null {
    const locked = this.junctions
      .filter((J) => this.t - J.lastActive >= GRIDLOCK_S - EPS)
      .map((J) => ({ node: J.node, sinceS: J.lastActive }));
    const net = this.st.count > 0 && this.t - this.netLastActive >= GRIDLOCK_S - EPS;
    if (!locked.length && !net) return null;
    const since = Math.min(net ? this.netLastActive : Infinity, ...locked.map((j) => j.sinceS));
    return { detected: true, sinceS: since, junctions: locked };
  }

  odRoutes(): { origin: string; destination: string; rateVph: number; segments: string[] }[] {
    const out: { origin: string; destination: string; rateVph: number; segments: string[] }[] = [];
    for (const o of this.origins) {
      for (const r of o.rows) {
        const d = this.destZones[r.dest]!;
        const ri = this.routeFor(o.link, d.link, o.zone, d.zone);
        out.push({ origin: o.zone, destination: d.zone, rateVph: r.rate, segments: this.routes[ri]!.segs.map((g) => this.segs[g]!.id) });
      }
    }
    return out;
  }

  signalCodes(): Uint8Array {
    const out = new Uint8Array(this.network.movements.length).fill(SIG.NONE);
    for (let mi = 0; mi < out.length; mi++) {
      const g = this.net.nLinks + mi;
      const pl = this.plan[g];
      if (pl) out[mi] = signalState(pl, this.segs[g]!.id, this.t);
    }
    return out;
  }

  private exit(k: number, tNew: number): void {
    const st = this.st;
    this.exited++;
    this.win.exited++;
    if (st.origin[k]! >= 0) {
      this.tripLog.push({
        id: st.id[k]!,
        origin: this.origins[st.origin[k]!]!.zone,
        destination: this.destZones[st.dest[k]!]!.zone,
        classId: this.classes[st.cls[k]!]!.id,
        tGen: st.tGen[k]!,
        tInsert: st.tIns[k]!,
        tExit: tNew,
        freeFlowS: this.freeFlow(k),
      });
    }
    st.release(k);
  }

  private freeFlow(k: number): number {
    return this.freeFlowOf(this.st.route[k]!, this.st.v0[k]!);
  }

  private freeFlowOf(route: number, v0: number): number {
    let tt = 0;
    for (const g of this.routes[route]!.segs) {
      const seg = this.segs[g]!;
      tt += seg.length / Math.min(v0, seg.speedLimitMps);
    }
    return tt;
  }

  private sortOcc(list: number[]): void {
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

  /* ================= demand (§2.1) and insertion (§2.3) ================= */

  private generate(tNew: number): void {
    this.origins.forEach((o, oi) => {
      while (o.next <= tNew) {
        const id = oi * ORIGIN_ID_STRIDE + o.k;
        o.k++;
        const vs = substream(this.sc.seed, Purpose.vehicle, id);
        const u = vs.next() * o.rate * 3600;
        let acc = 0;
        let dest = o.rows[o.rows.length - 1]!.dest;
        for (const r of o.rows) {
          acc += r.rate;
          if (u < acc) {
            dest = r.dest;
            break;
          }
        }
        const ci = this.pickClass(vs.next(), this.classShares(o.zone));
        const cls = this.classes[ci]!;
        const length = sampleDist(cls.lengthM, vs.next());
        const width = sampleDist(cls.widthM, vs.next());
        const uLat = vs.next();
        const drv = this.drawDriver(id, cls);
        const route = this.routeFor(o.link, this.destZones[dest]!.link, o.zone, this.destZones[dest]!.zone);
        this.queues[oi]!.push({ id, origin: oi, dest, cls: ci, length, width, ...drv, uLat, tGen: o.next, route });
        this.genLog.push({
          id,
          origin: o.zone,
          destination: this.destZones[dest]!.zone,
          classId: cls.id,
          tGen: o.next,
          length,
          width,
          ...drv,
          freeFlowS: this.freeFlowOf(route, drv.v0),
        });
        this.generated++;
        this.win.generated++;
        o.next += o.rng.exponential(o.rate);
      }
    });
  }

  private insertQueued(): void {
    for (let oi = 0; oi < this.origins.length; oi++) {
      const q = this.queues[oi]!;
      while (q.length > 0) {
        if (!this.tryInsert(q[0]!)) break;
        q.shift();
      }
    }
  }

  private tryInsert(p: Pending): boolean {
    const st = this.st;
    const o = this.origins[p.origin]!;
    const seg = this.segs[o.link]!;
    const cls = this.classes[p.cls]!;
    const route = this.routes[p.route]!;
    const v0eff = Math.min(p.v0, seg.speedLimitMps);
    const c = this.clearance(cls, v0eff);
    const h = p.width / 2 + c;
    const W = seg.widthM;
    const s = p.length;
    const ys: number[] = [];
    if (this.lane) {
      const lw = seg.layout.w;
      for (let m = 0; m < seg.layout.n; m++) ys.push(m * lw + lw / 2);
    } else {
      for (let m = 0; ; m++) {
        const y = h + m * seg.layout.w;
        if (y + h > W + EPS) break;
        ys.push(y);
      }
      if (ys.length === 0) ys.push(W / 2);
    }
    const yPref = h + p.uLat * (W - 2 * h);
    const D = this.lookahead(v0eff, p.b);
    const list = this.occ[o.link]!;
    let bestY = NaN;
    let bestGap = -Infinity;
    let bestV = 0;
    let bestIn = false;
    // Band of the route's next movement: candidates inside it are preferred (§2.3).
    const nx = this.nextSeg(route, 0);
    const band = nx && this.segs[nx.seg]!.kind === 'movement' ? effBand(this.segs[nx.seg]!) : null;
    const inBand = (y: number) =>
      !band || (y - p.width / 2 >= band[0] - EPS && y + p.width / 2 <= band[1] + EPS);
    // If any candidate fits the band, only in-band candidates are allowed (§2.3).
    const bandOnly = band !== null && ys.some(inBand);
    for (const y of ys) {
      if (bandOnly && !inBand(y)) continue;
      const [lo, hi] = this.spanAt(p.width, c, seg, y);
      // Any overlapping vehicle whose rear is behind the inserted front blocks this slot.
      let blocked = false;
      for (const j of list) {
        if (st.lo[j]! > hi || lo > st.hi[j]!) continue;
        if (st.s[j]! - st.len[j]! < s) {
          blocked = true;
          break;
        }
        if (st.s[j]! - this.maxLen >= s) break;
      }
      if (blocked) continue;
      const L = this.leader(-1, -1, seg, s, -Infinity, y, lo, hi, p.width, c, route, 0, D);
      const vIns = Math.min(v0eff, L.gap === Infinity ? v0eff : L.vl);
      if (!(L.gap >= p.s0 + vIns * p.T)) continue;
      const yIn = inBand(y);
      const better =
        (yIn && !bestIn) ||
        (yIn === bestIn && L.gap > bestGap) ||
        (yIn === bestIn && L.gap === bestGap &&
          (Math.abs(y - yPref) < Math.abs(bestY - yPref) - EPS ||
            (Math.abs(Math.abs(y - yPref) - Math.abs(bestY - yPref)) <= EPS && y < bestY)));
      if (better) {
        bestGap = L.gap;
        bestY = y;
        bestV = vIns;
        bestIn = yIn;
      }
    }
    if (Number.isNaN(bestY)) return false;
    const k = this.place(p.id, p.cls, p.length, p.width, p, o.link, p.route, s, bestY, bestV);
    this.generated--; // already counted at generation
    st.cOcc[k] = c;
    const [lo, hi] = this.spanOf(k, seg, bestY, bestY);
    st.lo[k] = lo;
    st.hi[k] = hi;
    st.origin[k] = p.origin;
    st.dest[k] = p.dest;
    st.tGen[k] = p.tGen;
    st.tIns[k] = this.t;
    this.win.inserted++;
    this.insertedTotal++;
    return true;
  }

  addVehicle(spec: AddVehicleSpec): number {
    const ci = this.classes.findIndex((c) => c.id === spec.classId);
    if (ci < 0) throw new Error(`unknown class ${spec.classId}`);
    // `link` may be a link or a movement id (§2.7).
    let seg = this.net.segByLinkId.get(spec.link);
    if (seg === undefined) seg = this.segs.find((x) => x.kind === 'movement' && x.id === spec.link)?.index;
    if (seg === undefined) throw new Error(`unknown link or movement ${spec.link}`);
    const cls = this.classes[ci]!;
    const sizeOf = (d: Dist) => (d.kind === 'fixed' ? d.value : sampleDist(d, 0.5));
    const id = ADDED_ID_BASE + this.addedCount++;
    const base = { v0: cls.idm.v0.value, T: cls.idm.T.value, s0: cls.idm.s0.value, a: cls.idm.a.value, b: cls.idm.b.value };
    this.place(id, ci, sizeOf(cls.lengthM), sizeOf(cls.widthM), base, seg, this.defaultRoute(seg), spec.s, spec.y, spec.v);
    return id;
  }

  /* ================= outputs ================= */

  private sampleSeries(): void {
    const w = this.win;
    const st = this.st;
    let sum = 0;
    for (let k = 0; k < st.cap; k++) if (st.alive[k]) sum += st.v[k]!;
    w.speedSum += st.count ? sum / st.count : 0;
    w.densSum += this.linkKm > 0 ? st.count / this.linkKm : 0;
    w.samples++;
    const t1 = w.t0 + SERIES_WINDOW_S;
    if (this.t >= t1 - EPS) {
      this.rows.push({
        t0: w.t0,
        t1,
        generated: w.generated,
        inserted: w.inserted,
        exited: w.exited,
        exitFlowVph: (w.exited * 3600) / SERIES_WINDOW_S,
        meanSpeedMps: w.samples ? w.speedSum / w.samples : 0,
        densityPerKm: w.samples ? w.densSum / w.samples : 0,
        entryQueue: this.queueLength(),
        onNetwork: st.count,
        lockedJunctions: this.gridlock()?.junctions.length ?? 0,
      });
      this.win = { t0: t1, generated: 0, inserted: 0, exited: 0, speedSum: 0, densSum: 0, samples: 0 };
    }
  }

  private queueLength(): number {
    let n = 0;
    for (const q of this.queues) n += q.length;
    return n;
  }

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
      targetY: st.ty[k]!,
      freeFlowTravelledS: st.ffTrav[k]!,
    }));
  }

  vehicleCount(): number {
    return this.st.count;
  }

  counters(): SimCounters {
    return { generated: this.generated, exited: this.exited, onNetwork: this.st.count, entryQueue: this.queueLength() };
  }

  linkStats(): Record<string, LinkStats> {
    const out: Record<string, LinkStats> = {};
    this.segs.forEach((seg, i) => (out[seg.id] = { ...this.stats[i]! }));
    return out;
  }

  trips(): TripRecord[] {
    return this.tripLog.slice();
  }

  generatedLog(): GeneratedRecord[] {
    return this.genLog.slice();
  }

  series(): SeriesRow[] {
    return this.rows.slice();
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
      const pt = pointAt(seg, st.s[k]! - st.len[k]! / 2);
      const off = seg.widthM / 2 - st.y[k]!;
      const o = n * FRAME_STRIDE;
      out[o + F_X] = pt.x - pt.ty * off;
      out[o + F_Y] = pt.y + pt.tx * off;
      out[o + F_HEADING] = Math.atan2(pt.ty, pt.tx);
      out[o + F_CLASS] = st.cls[k]!;
      out[o + F_LENGTH] = st.len[k]!;
      out[o + F_WIDTH] = st.wid[k]!;
      // Drawing layer: links count as elevated only if they actually rise (z > 0.5 m).
      const link = seg.kind === 'link' ? this.network.links[seg.index]! : null;
      out[o + F_LAYER] = link && !(link.zFromM > 0.5 || link.zToM > 0.5) ? 0 : link ? Math.max(1, seg.layer) : seg.layer;
      n++;
    }
    return n;
  }
}

const P: IdmParams = { v0: 0, T: 0, s0: 0, a: 0, b: 0 };
const hashView = new DataView(new ArrayBuffer(8));

export function createSim(input: SimInput): Sim {
  return new SimImpl(input);
}
