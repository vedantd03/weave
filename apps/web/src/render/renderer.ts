import type { Network, VehicleClassId } from '@weave/engine';
import { FRAME_STRIDE, F_CLASS, F_HEADING, F_LAYER, F_LENGTH, F_SEG, F_SPEED, F_SPEED_RATIO, F_WIDTH, F_X, F_Y } from '@weave/engine/protocol';
import { networkBounds, offsetPolyline, ribbon, type Bounds, type Pt } from './geometry.ts';
import { classCss, readMapTheme, speedCss, type ColourMode, type MapTheme } from './palette.ts';

const SPEED_BINS = 20;

/** What the user is inspecting (§6.3 item 5). Vehicle records are a copy of the frame record. */
export type Selection =
  | { kind: 'vehicle'; rec: Float32Array }
  | { kind: 'road'; seg: number; onNow: number; meanSpeedMps: number };

interface RoadShape {
  /** Network segment index: links first, then movements (§6.1 F_SEG). */
  seg: number;
  layer: number;
  surface: Path2D;
  edges: Path2D;
  markings: Path2D | null;
}

interface Camera {
  /** World point at the canvas centre. */
  cx: number;
  cy: number;
  /** Pixels (CSS) per metre. */
  scale: number;
}

export interface FrameView {
  data: Float32Array;
  count: number;
  /** Signal colour per network movement (SIG codes; 255 = uncontrolled). */
  signals?: Uint8Array;
}

interface SignalHead {
  movement: number;
  x: number;
  y: number;
  layer: number;
}

/**
 * Canvas2D renderer. Roads are cached as world-space Path2D objects; each frame sets one
 * transform and fills them, then batches vehicles into one path per (layer, class).
 * Draw order per layer: shadow (layer > 0), surface, edges, markings, vehicles — so flyovers
 * cover the traffic beneath them.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private roads: RoadShape[] = [];
  private heads: SignalHead[] = [];
  private layers: number[] = [0];
  private bounds: Bounds | null = null;
  private cam: Camera = { cx: 0, cy: 0, scale: 1 };
  private theme: MapTheme;
  private classIds: VehicleClassId[] = [];
  private frame: FrameView | null = null;
  private colourMode: ColourMode = 'class';
  private selection: Selection | null = null;
  private onSelect: ((s: Selection | null) => void) | null = null;
  private dirty = true;
  private raf = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private userMoved = false;
  /** Point of interest the default view centres on (e.g. a corridor's change point). */
  private focus: [number, number] | null = null;
  private detach: Array<() => void> = [];

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D unavailable');
    this.ctx = ctx;
    this.theme = readMapTheme();
    this.attachInteraction();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.detach.push(() => ro.disconnect());
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onTheme = () => {
      this.theme = readMapTheme();
      this.dirty = true;
    };
    mq.addEventListener('change', onTheme);
    this.detach.push(() => mq.removeEventListener('change', onTheme));
    this.resize();
    const loop = () => {
      if (this.dirty) this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.detach) d();
  }

  setNetwork(net: Network, classIds: VehicleClassId[], focus: [number, number] | null = null): void {
    this.focus = focus;
    this.classIds = classIds;
    const layerOfNode = new Map(net.nodes.map((n) => [n.id, n.layer]));
    this.roads = [];
    // Elevation drives the drawing order: a link is drawn as elevated only if it actually
    // rises (z > 0.5 m), so at-grade bridges over drains are not styled as flyovers.
    net.links.forEach((l, i) => {
      const elevated = l.zFromM > 0.5 || l.zToM > 0.5;
      this.roads.push(this.buildRoad(i, l.polyline as Pt[], l.widthM, l.lanes, elevated ? Math.max(1, l.layer) : 0));
    });
    // One signal head per signal-controlled movement, at the start of its path.
    const signalNodes = new Set(net.signals.map((p) => p.node));
    this.heads = [];
    net.movements.forEach((m, i) => {
      if (m.control !== 'signal' || !signalNodes.has(m.node)) return;
      const p = m.path[0]!;
      this.heads.push({ movement: i, x: p[0], y: p[1], layer: layerOfNode.get(m.node) ?? 0 });
    });
    net.movements.forEach((m, i) => {
      const layer = layerOfNode.get(m.node) ?? 0;
      this.roads.push(this.buildRoad(net.links.length + i, m.path as Pt[], m.widthM, 1, layer, false));
    });
    this.layers = [...new Set(this.roads.map((r) => r.layer))].sort((a, b) => a - b);
    this.bounds = networkBounds(net);
    this.userMoved = false;
    this.fit();
    this.frame = null;
    this.select(null);
    this.dirty = true;
  }

  setColourMode(mode: ColourMode): void {
    this.colourMode = mode;
    this.dirty = true;
  }

  setFrame(frame: FrameView): void {
    this.frame = frame;
    this.dirty = true;
    if (this.selection) this.select(this.track(this.selection));
  }

  /** Called with the current selection after every change and every frame while one is active. */
  setSelectionListener(cb: ((s: Selection | null) => void) | null): void {
    this.onSelect = cb;
  }

  clearSelection(): void {
    this.select(null);
  }

  private select(s: Selection | null): void {
    const had = this.selection !== null;
    this.selection = s;
    this.dirty = true;
    if (s || had) this.onSelect?.(s);
  }

  /** World (m) → page coordinates (CSS px), for tests and overlays. */
  worldToClient(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + this.cssW / 2 + (x - this.cam.cx) * this.cam.scale, y: r.top + this.cssH / 2 - (y - this.cam.cy) * this.cam.scale };
  }

  private clientToWorld(cx: number, cy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [this.cam.cx + (cx - r.left - this.cssW / 2) / this.cam.scale, this.cam.cy - (cy - r.top - this.cssH / 2) / this.cam.scale];
  }

  /** Road statistics now: vehicles whose front is on segment `seg` and their mean speed. */
  private roadNow(seg: number): Selection {
    let n = 0;
    let sum = 0;
    const f = this.frame;
    if (f) {
      for (let i = 0; i < f.count; i++) {
        const o = i * FRAME_STRIDE;
        if (f.data[o + F_SEG] === seg) {
          n++;
          sum += f.data[o + F_SPEED]!;
        }
      }
    }
    return { kind: 'road', seg, onNow: n, meanSpeedMps: n ? sum / n : NaN };
  }

  /** Hit-test a page point: the topmost vehicle under it, else the topmost road, else null. */
  pick(clientX: number, clientY: number): Selection | null {
    const [wx, wy] = this.clientToWorld(clientX, clientY);
    const tol = Math.max(4 / this.cam.scale, 0.3); // 4 CSS px, at least 0.3 m
    const f = this.frame;
    let best = -1;
    let bestLayer = -Infinity;
    let bestD = Infinity;
    if (f) {
      for (let i = 0; i < f.count; i++) {
        const o = i * FRAME_STRIDE;
        const dx = wx - f.data[o + F_X]!;
        const dy = wy - f.data[o + F_Y]!;
        const h = f.data[o + F_HEADING]!;
        const lx = dx * Math.cos(h) + dy * Math.sin(h);
        const ly = -dx * Math.sin(h) + dy * Math.cos(h);
        if (Math.abs(lx) > f.data[o + F_LENGTH]! / 2 + tol || Math.abs(ly) > f.data[o + F_WIDTH]! / 2 + tol) continue;
        const layer = f.data[o + F_LAYER]!;
        const d = dx * dx + dy * dy;
        if (layer > bestLayer || (layer === bestLayer && d < bestD)) {
          best = i;
          bestLayer = layer;
          bestD = d;
        }
      }
    }
    if (best >= 0) return { kind: 'vehicle', rec: f!.data.slice(best * FRAME_STRIDE, (best + 1) * FRAME_STRIDE) };
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr;
    const py = (clientY - r.top) * this.dpr;
    this.applyWorldTransform();
    for (const layer of [...this.layers].reverse()) {
      // Movements were added after links, so search in reverse: junction paths win on top.
      for (let k = this.roads.length - 1; k >= 0; k--) {
        const road = this.roads[k]!;
        if (road.layer === layer && this.ctx.isPointInPath(road.surface, px, py)) return this.roadNow(road.seg);
      }
    }
    return null;
  }

  /** Follow a selected vehicle into the new frame: same class and size, nearest to where it was. */
  private track(s: Selection): Selection | null {
    if (s.kind === 'road') return this.roadNow(s.seg);
    const f = this.frame;
    if (!f) return null;
    const r = s.rec;
    let best = -1;
    let bestD = 30 * 30; // a vehicle moves < 30 m between displayed frames even at 60×
    for (let i = 0; i < f.count; i++) {
      const o = i * FRAME_STRIDE;
      if (f.data[o + F_CLASS] !== r[F_CLASS] || f.data[o + F_LENGTH] !== r[F_LENGTH] || f.data[o + F_WIDTH] !== r[F_WIDTH]) continue;
      const dx = f.data[o + F_X]! - r[F_X]!;
      const dy = f.data[o + F_Y]! - r[F_Y]!;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? { kind: 'vehicle', rec: f.data.slice(best * FRAME_STRIDE, (best + 1) * FRAME_STRIDE) } : null;
  }

  private drawSelection(px: number): void {
    const s = this.selection;
    if (!s) return;
    const { ctx } = this;
    ctx.strokeStyle = this.theme.dark ? '#fbbf24' : '#b45309';
    if (s.kind === 'road') {
      const road = this.roads.find((r) => r.seg === s.seg);
      if (!road) return;
      ctx.lineWidth = 3 * px;
      ctx.stroke(road.surface);
      return;
    }
    const r = s.rec;
    const hl = Math.max(r[F_LENGTH]!, 2.2 * px) / 2 + 3 * px;
    const hw = Math.max(r[F_WIDTH]!, 1.6 * px) / 2 + 3 * px;
    ctx.save();
    ctx.translate(r[F_X]!, r[F_Y]!);
    ctx.rotate(r[F_HEADING]!);
    ctx.lineWidth = 2 * px;
    ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw);
    ctx.restore();
  }

  /**
   * Fit the network in view. For very elongated networks (a 1 km × 10 m corridor) a plain fit
   * makes the road a hairline, so by default the narrow side is shown at ≥ 90 px, centred;
   * `whole = true` (Fit view button, double-click) always shows everything.
   */
  fit(whole = false): void {
    if (!this.bounds || this.cssW === 0) return;
    const b = this.bounds;
    const pad = 24;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    let scale = Math.min((this.cssW - 2 * pad) / w, (this.cssH - 2 * pad) / h);
    if (!whole) {
      const narrow = Math.min(w, h);
      if (narrow * scale < 90) scale = Math.min(90 / narrow, 12);
    }
    const zoomed = !whole && scale > Math.min((this.cssW - 2 * pad) / w, (this.cssH - 2 * pad) / h) + 1e-9;
    const c = zoomed && this.focus ? this.focus : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    this.cam = { cx: c[0]!, cy: c[1]!, scale };
    this.dirty = true;
  }

  private buildRoad(seg: number, centre: Pt[], widthM: number, lanes: number, layer: number, edges = true): RoadShape {
    const surface = new Path2D();
    const poly = ribbon(centre, widthM);
    poly.forEach((p, i) => (i === 0 ? surface.moveTo(p[0], p[1]) : surface.lineTo(p[0], p[1])));
    surface.closePath();
    const edgePath = new Path2D();
    if (edges) {
      for (const side of [widthM / 2, -widthM / 2]) {
        offsetPolyline(centre, side).forEach((p, i) => (i === 0 ? edgePath.moveTo(p[0], p[1]) : edgePath.lineTo(p[0], p[1])));
      }
    }
    let markings: Path2D | null = null;
    if (edges && lanes > 1) {
      markings = new Path2D();
      const lw = widthM / lanes;
      for (let k = 1; k < lanes; k++) {
        offsetPolyline(centre, widthM / 2 - k * lw).forEach((p, i) => (i === 0 ? markings!.moveTo(p[0], p[1]) : markings!.lineTo(p[0], p[1])));
      }
    }
    return { seg, layer, surface, edges: edgePath, markings };
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    if (!this.userMoved) this.fit();
    this.dirty = true;
  }

  /** World → CSS-pixel transform; y is flipped so north is up. */
  private applyWorldTransform(): void {
    const { cx, cy, scale } = this.cam;
    const s = scale * this.dpr;
    this.ctx.setTransform(s, 0, 0, -s, (this.cssW / 2 - cx * scale) * this.dpr, (this.cssH / 2 + cy * scale) * this.dpr);
  }

  private draw(): void {
    this.dirty = false;
    const { ctx, theme } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.roads.length === 0) return;
    this.applyWorldTransform();
    const px = 1 / this.cam.scale; // one CSS pixel in metres

    for (const layer of this.layers) {
      const roads = this.roads.filter((r) => r.layer === layer);
      if (layer > 0) {
        // Drop shadow offset south-east, scaled with height.
        ctx.save();
        ctx.translate(2.5 * layer, -2.5 * layer);
        ctx.fillStyle = theme.shadow;
        for (const r of roads) ctx.fill(r.surface);
        ctx.restore();
      }
      ctx.fillStyle = layer > 0 ? theme.flyover : theme.road;
      for (const r of roads) ctx.fill(r.surface);
      ctx.strokeStyle = theme.roadEdge;
      ctx.lineWidth = 1.2 * px;
      for (const r of roads) ctx.stroke(r.edges);
      if (this.cam.scale > 1.5) {
        ctx.strokeStyle = theme.marking;
        ctx.lineWidth = Math.max(0.12, px);
        ctx.setLineDash([3, 4.5]);
        for (const r of roads) if (r.markings) ctx.stroke(r.markings);
        ctx.setLineDash([]);
      }
      this.drawVehicles(layer, px);
      this.drawSignals(layer, px);
    }
    this.drawSelection(px);
  }

  private drawSignals(layer: number, px: number): void {
    const sig = this.frame?.signals;
    if (!sig || this.heads.length === 0) return;
    const { ctx } = this;
    const r = Math.max(0.9, 3 * px);
    const colours: Record<number, string> = { 0: '#ef4444', 1: '#f59e0b', 2: '#22c55e', 3: '#38bdf8' };
    for (const h of this.heads) {
      if (h.layer !== layer) continue;
      const c = colours[sig[h.movement] ?? 255];
      if (!c) continue;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = Math.max(0.15, px);
      ctx.strokeStyle = this.theme.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
  }

  private drawVehicles(layer: number, px: number): void {
    const f = this.frame;
    if (!f || f.count === 0) return;
    const { ctx } = this;
    const d = f.data;
    // One path per colour bucket: classes, or 21 speed bins (ratio 0, 0.05, …, 1).
    const bySpeed = this.colourMode === 'speed';
    const nClasses = Math.max(this.classIds.length, 1);
    const nBuckets = bySpeed ? SPEED_BINS + 1 : nClasses;
    const paths: Path2D[] = Array.from({ length: nBuckets }, () => new Path2D());
    // Below ~1.2 px/m vehicles become sub-pixel: enforce a minimum visible footprint.
    const minLen = 2.2 * px;
    const minWid = 1.6 * px;
    for (let i = 0; i < f.count; i++) {
      const o = i * FRAME_STRIDE;
      if (d[o + F_LAYER] !== layer) continue;
      const x = d[o + F_X]!;
      const y = d[o + F_Y]!;
      const h = d[o + F_HEADING]!;
      const hl = Math.max(d[o + F_LENGTH]!, minLen) / 2;
      const hw = Math.max(d[o + F_WIDTH]!, minWid) / 2;
      const c = Math.cos(h);
      const s = Math.sin(h);
      const bucket = bySpeed ? Math.round(d[o + F_SPEED_RATIO]! * SPEED_BINS) : Math.min(d[o + F_CLASS]! | 0, nClasses - 1);
      const p = paths[bucket]!;
      p.moveTo(x + c * hl - s * hw, y + s * hl + c * hw);
      p.lineTo(x - c * hl - s * hw, y - s * hl + c * hw);
      p.lineTo(x - c * hl + s * hw, y - s * hl - c * hw);
      p.lineTo(x + c * hl + s * hw, y + s * hl - c * hw);
      p.closePath();
    }
    for (let k = 0; k < nBuckets; k++) {
      ctx.fillStyle = bySpeed ? speedCss(k / SPEED_BINS) : classCss(this.classIds[k], this.theme.dark);
      ctx.fill(paths[k]!);
    }
  }

  private attachInteraction(): void {
    const el = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;

    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const rect = el.getBoundingClientRect();
      const sx = clientX - rect.left - this.cssW / 2;
      const sy = clientY - rect.top - this.cssH / 2;
      const wx = this.cam.cx + sx / this.cam.scale;
      const wy = this.cam.cy - sy / this.cam.scale;
      const scale = Math.min(Math.max(this.cam.scale * factor, 0.05), 80);
      this.cam = { scale, cx: wx - sx / scale, cy: wy + sy / scale };
      this.userMoved = true;
      this.dirty = true;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    let downAt: { x: number; y: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // Hover with a mouse (no button down) inspects whatever is under the cursor.
        if (e.pointerType === 'mouse') this.select(this.pick(e.clientX, e.clientY));
        return;
      }
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        this.cam = {
          ...this.cam,
          cx: this.cam.cx - (cur.x - prev.x) / this.cam.scale,
          cy: this.cam.cy + (cur.y - prev.y) / this.cam.scale,
        };
        this.userMoved = true;
        this.dirty = true;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinchDist > 0) zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, dist / pinchDist);
        pinchDist = dist;
      }
    };
    const onUp = (e: PointerEvent) => {
      // A tap or click (no drag) selects what is under it, or clears on empty ground.
      if (downAt && downAt.id === e.pointerId && pointers.size === 1 && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) {
        this.select(this.pick(e.clientX, e.clientY));
      }
      downAt = null;
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.select(null);
    };
    window.addEventListener('keydown', onKey);
    this.detach.push(() => window.removeEventListener('keydown', onKey));
    const onDbl = () => {
      this.userMoved = true;
      this.fit(true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('dblclick', onDbl);
    this.detach.push(() => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('dblclick', onDbl);
    });
  }
}
