/**
 * Gap acceptance (docs/MODEL.md §3.3). A minor-stream vehicle may enter when the time to the
 * next priority arrival is at least tc and at least tf has passed since the previous entry.
 * With Poisson major arrivals at rate q this reproduces Harders' capacity
 * q·e^{−q·tc} / (1 − e^{−q·tf}).
 */
export function acceptGap(timeToNextPriority: number, sinceLastEntry: number, tc: number, tf: number): boolean {
  return timeToNextPriority >= tc && sinceLastEntry >= tf;
}

/** Entry times of an always-present minor queue against sorted major arrival times. */
export function saturatedDischarge(majorArrivals: readonly number[], tc: number, tf: number, horizon: number): number[] {
  const out: number[] = [];
  let t = 0;
  let earliest = 0; // previous entry + tf
  let j = 0; // index of the first major arrival strictly after t
  for (;;) {
    while (j < majorArrivals.length && majorArrivals[j]! <= t) j++;
    if (!(t < horizon)) break;
    const next = j < majorArrivals.length ? majorArrivals[j]! : Infinity;
    if (next - t >= tc) {
      out.push(t);
      earliest = t + tf;
      t = earliest;
    } else {
      t = Math.max(next, earliest); // wait until this major vehicle has passed
    }
  }
  return out;
}
