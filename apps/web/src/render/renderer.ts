import type { Network, VehicleClassId } from '@weave/engine';
import { FRAME_STRIDE, F_CLASS, F_HEADING, F_LAYER, F_LENGTH, F_WIDTH, F_X, F_Y } from '@weave/engine/protocol';
import { networkBounds, offsetPolyline, ribbon, type Bounds, type Pt } from './geometry.ts';
import { CLASS_COLORS, readMapTheme, type MapTheme } from './palette.ts';

interface RoadShape {
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
  private dirty = true;
  private raf = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private userMoved = false;
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

  setNetwork(net: Network, classIds: VehicleClassId[]): void {
    this.classIds = classIds;
    const layerOfNode = new Map(net.nodes.map((n) => [n.id, n.layer]));
    this.roads = [];
    // Elevation drives the drawing order: a link is drawn as elevated only if it actually
    // rises (z > 0.5 m), so at-grade bridges over drains are not styled as flyovers.
    for (const l of net.links) {
      const elevated = l.zFromM > 0.5 || l.zToM > 0.5;
      this.roads.push(this.buildRoad(l.polyline as Pt[], l.widthM, l.lanes, elevated ? Math.max(1, l.layer) : 0));
    }
    // One signal head per signal-controlled movement, at the start of its path.
    const signalNodes = new Set(net.signals.map((p) => p.node));
    this.heads = [];
    net.movements.forEach((m, i) => {
      if (m.control !== 'signal' || !signalNodes.has(m.node)) return;
      const p = m.path[0]!;
      this.heads.push({ movement: i, x: p[0], y: p[1], layer: layerOfNode.get(m.node) ?? 0 });
    });
    for (const m of net.movements) {
      const layer = layerOfNode.get(m.node) ?? 0;
      this.roads.push(this.buildRoad(m.path as Pt[], m.widthM, 1, layer, false));
    }
    this.layers = [...new Set(this.roads.map((r) => r.layer))].sort((a, b) => a - b);
    this.bounds = networkBounds(net);
    this.userMoved = false;
    this.fit();
    this.frame = null;
    this.dirty = true;
  }

  setFrame(frame: FrameView): void {
    this.frame = frame;
    this.dirty = true;
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
    this.cam = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale };
    this.dirty = true;
  }

  private buildRoad(centre: Pt[], widthM: number, lanes: number, layer: number, edges = true): RoadShape {
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
    return { layer, surface, edges: edgePath, markings };
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
    const nClasses = Math.max(this.classIds.length, 1);
    const paths: Path2D[] = Array.from({ length: nClasses }, () => new Path2D());
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
      const p = paths[Math.min(d[o + F_CLASS]! | 0, nClasses - 1)]!;
      p.moveTo(x + c * hl - s * hw, y + s * hl + c * hw);
      p.lineTo(x - c * hl - s * hw, y - s * hl + c * hw);
      p.lineTo(x - c * hl + s * hw, y - s * hl - c * hw);
      p.lineTo(x + c * hl + s * hw, y + s * hl - c * hw);
      p.closePath();
    }
    for (let k = 0; k < nClasses; k++) {
      const id = this.classIds[k];
      const col = id ? CLASS_COLORS[id] : undefined;
      ctx.fillStyle = col ? (this.theme.dark ? col.dark : col.light) : '#e6edf3';
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
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
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
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
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
