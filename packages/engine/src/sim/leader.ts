/**
 * Leader rule (docs/MODEL.md §1.6): among vehicles ahead whose strips overlap, the leader is the
 * one with the nearest REAR end (not the nearest front). Shared with the data pipeline.
 */

export interface LeaderInput {
  front: number;
  length: number;
  lo: number;
  hi: number;
}

/** Leader index per vehicle, or −1. O(n log n) sort plus a pruned forward scan. */
export function findLeaders(vs: readonly LeaderInput[]): Int32Array {
  const n = vs.length;
  const out = new Int32Array(n).fill(-1);
  if (n < 2) return out;
  // Order by (front, index): "ahead" = later in this order (equal fronts: larger index).
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => vs[a]!.front - vs[b]!.front || a - b);
  let maxLen = 0;
  for (const v of vs) if (v.length > maxLen) maxLen = v.length;
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const me = vs[i]!;
    let best = -1;
    let bestRear = Infinity;
    for (let m = k + 1; m < n; m++) {
      const j = order[m]!;
      const o = vs[j]!;
      // Any later vehicle has rear >= front − maxLen; stop once none can beat the best rear.
      if (o.front - maxLen > bestRear) break;
      if (o.lo > me.hi || me.lo > o.hi) continue;
      const rear = o.front - o.length;
      if (rear < bestRear || (rear === bestRear && j < best)) {
        bestRear = rear;
        best = j;
      }
    }
    out[i] = best;
  }
  return out;
}
