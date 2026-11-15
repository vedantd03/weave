import { FRAME_STRIDE, F_CLASS, F_LENGTH, F_SEG, F_SPEED, F_WIDTH, F_X, F_Y } from '@weave/engine/protocol';

/** Shared selection logic for the 2D and 3D views (MODEL.md §6.3 items 5 and 8). */

export interface FrameLike {
  data: Float32Array;
  count: number;
}

/** What the user is inspecting. Vehicle records are a copy of the frame record. */
export type Selection =
  | { kind: 'vehicle'; rec: Float32Array }
  | { kind: 'road'; seg: number; onNow: number; meanSpeedMps: number };

export function vehicleAt(f: FrameLike, i: number): Selection {
  return { kind: 'vehicle', rec: f.data.slice(i * FRAME_STRIDE, (i + 1) * FRAME_STRIDE) };
}

/** Road statistics now: vehicles whose front is on segment `seg` and their mean speed. */
export function roadNow(f: FrameLike | null, seg: number): Selection {
  let n = 0;
  let sum = 0;
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

/**
 * Follow a selection into a new frame. Frames carry no vehicle id, so a vehicle is matched by
 * class, length and width nearest to where it was (rendering only, never fed back to the sim).
 */
export function track(s: Selection, f: FrameLike | null): Selection | null {
  if (s.kind === 'road') return roadNow(f, s.seg);
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
  return best >= 0 ? vehicleAt(f, best) : null;
}
