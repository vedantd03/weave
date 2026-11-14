import type { Network } from '../schema/network.ts';
import { stripLayout, type StripLayout } from './strips.ts';

/**
 * Internal, simulation-ready view of a Network. Links and movement paths are both "segments"
 * (links first, then movements). Lengths come from polylines via sqrt only (deterministic).
 */
export interface Segment {
  index: number;
  id: string;
  kind: 'link' | 'movement';
  xs: Float64Array;
  ys: Float64Array;
  /** Cumulative arc length at each polyline vertex. */
  cum: Float64Array;
  length: number;
  widthM: number;
  speedLimitMps: number;
  layer: number;
  layout: StripLayout;
  /** Segments that may follow this one (links → movements; movement → its toLink). */
  next: number[];
  /** For movements: lateral bands on the from/to links (m from the left edge). */
  fromLateral: [number, number];
  toLateral: [number, number];
  /** For movements: index of the movement in network.movements; for links −1. */
  movementIndex: number;
}

export interface BuiltNetwork {
  network: Network;
  segments: Segment[];
  segByLinkId: Map<string, number>;
  nLinks: number;
}

function polyArrays(poly: readonly (readonly [number, number])[]) {
  const n = poly.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = poly[i]![0];
    ys[i] = poly[i]![1];
    if (i > 0) {
      const dx = xs[i]! - xs[i - 1]!;
      const dy = ys[i]! - ys[i - 1]!;
      cum[i] = cum[i - 1]! + Math.sqrt(dx * dx + dy * dy);
    }
  }
  return { xs, ys, cum, length: cum[n - 1]! };
}

export function buildNetwork(net: Network, mode: 'strip' | 'lane', stripWidthM: number): BuiltNetwork {
  const segments: Segment[] = [];
  const segByLinkId = new Map<string, number>();
  for (const l of net.links) {
    const p = polyArrays(l.polyline);
    const layout = mode === 'lane' ? stripLayout(l.widthM, l.widthM / l.lanes) : stripLayout(l.widthM, stripWidthM);
    segByLinkId.set(l.id, segments.length);
    segments.push({
      index: segments.length,
      id: l.id,
      kind: 'link',
      ...p,
      widthM: l.widthM,
      speedLimitMps: l.speedLimitMps,
      layer: l.layer,
      layout,
      next: [],
      fromLateral: [0, l.widthM],
      toLateral: [0, l.widthM],
      movementIndex: -1,
    });
  }
  const nLinks = segments.length;
  const layerOfNode = new Map(net.nodes.map((n) => [n.id, n.layer]));
  net.movements.forEach((m, mi) => {
    const from = segments[segByLinkId.get(m.fromLink)!]!;
    const to = segments[segByLinkId.get(m.toLink)!]!;
    const p = polyArrays(m.path);
    let layout: StripLayout;
    if (mode === 'lane') {
      const laneW = from.widthM / (net.links[from.index]!.lanes || 1);
      layout = stripLayout(m.widthM, m.widthM / Math.max(1, Math.floor(m.widthM / laneW + 0.5)));
    } else {
      layout = stripLayout(m.widthM, stripWidthM);
    }
    const idx = segments.length;
    segments.push({
      index: idx,
      id: m.id,
      kind: 'movement',
      ...p,
      widthM: m.widthM,
      speedLimitMps: Math.min(from.speedLimitMps, to.speedLimitMps),
      layer: layerOfNode.get(m.node) ?? 0,
      layout,
      next: [to.index],
      fromLateral: [m.fromLateral[0], m.fromLateral[1]],
      toLateral: [m.toLateral[0], m.toLateral[1]],
      movementIndex: mi,
    });
    from.next.push(idx);
  });
  return { network: net, segments, segByLinkId, nLinks };
}

/** Map a lateral position (from the left edge) when moving from segment a onto segment b. */
export function mapLateral(a: Segment, b: Segment, y: number): number {
  let out = y;
  if (a.kind === 'link' && b.kind === 'movement') out = y - b.fromLateral[0];
  else if (a.kind === 'movement' && b.kind === 'link') out = y + a.toLateral[0];
  return out < 0 ? 0 : out > b.widthM ? b.widthM : out;
}

/** Point and unit tangent at arc length s along a segment (clamped to its ends). */
export function pointAt(seg: Segment, s: number): { x: number; y: number; tx: number; ty: number } {
  const { xs, ys, cum } = seg;
  const n = xs.length;
  if (s <= 0 || seg.length === 0) return tangentAt(seg, 0, 0);
  if (s >= seg.length) return tangentAt(seg, n - 2, 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const segLen = cum[lo + 1]! - cum[lo]!;
  return tangentAt(seg, lo, segLen > 0 ? (s - cum[lo]!) / segLen : 0);
}

function tangentAt(seg: Segment, i: number, f: number) {
  const { xs, ys } = seg;
  const j = Math.min(Math.max(i, 0), xs.length - 2);
  const dx = xs[j + 1]! - xs[j]!;
  const dy = ys[j + 1]! - ys[j]!;
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: xs[j]! + dx * f, y: ys[j]! + dy * f, tx: dx / l, ty: dy / l };
}
