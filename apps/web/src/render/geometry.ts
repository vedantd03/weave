import type { Network } from '@weave/engine';

/** Rendering-only geometry (may use transcendental functions: it never feeds simulation state). */

export type Pt = [number, number];

/** Offset a polyline to its left by d metres (negative d = right), with clamped miter joins. */
export function offsetPolyline(poly: readonly Pt[], d: number): Pt[] {
  const n = poly.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[Math.max(0, i - 1)]!;
    const next = poly[Math.min(n - 1, i + 1)]!;
    const cur = poly[i]!;
    // Left normals of the adjacent segments.
    const n1 = leftNormal(i > 0 ? prev : cur, i > 0 ? cur : next);
    const n2 = leftNormal(i < n - 1 ? cur : prev, i < n - 1 ? next : cur);
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = n1[0];
      my = n1[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    // Miter length 1/cos(theta/2), clamped so sharp corners don't spike.
    const cosHalf = mx * n1[0] + my * n1[1];
    const k = d / Math.max(cosHalf, 0.35);
    out.push([cur[0] + mx * k, cur[1] + my * k]);
  }
  return out;
}

function leftNormal(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

/** Closed polygon of a carriageway of the given width around a centreline. */
export function ribbon(centre: readonly Pt[], widthM: number): Pt[] {
  const left = offsetPolyline(centre, widthM / 2);
  const right = offsetPolyline(centre, -widthM / 2);
  return [...left, ...right.reverse()];
}

export function polylineLength(poly: readonly Pt[]): number {
  let L = 0;
  for (let i = 1; i < poly.length; i++) {
    L += Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]);
  }
  return L;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function networkBounds(net: Network): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p: readonly number[]) => {
    b.minX = Math.min(b.minX, p[0]!);
    b.maxX = Math.max(b.maxX, p[0]!);
    b.minY = Math.min(b.minY, p[1]!);
    b.maxY = Math.max(b.maxY, p[1]!);
  };
  for (const l of net.links) {
    const pad = l.widthM / 2;
    for (const p of l.polyline) {
      add([p[0] - pad, p[1] - pad]);
      add([p[0] + pad, p[1] + pad]);
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  return b;
}
