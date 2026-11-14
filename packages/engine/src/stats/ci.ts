import { tQuantile } from './tdist.ts';

export interface CI {
  mean: number;
  half: number;
  lo: number;
  hi: number;
  n: number;
  sd: number;
}

/** Student-t confidence interval of the mean (docs/MODEL.md §5.1). */
export function meanCI(xs: readonly number[], level = 0.95): CI {
  const n = xs.length;
  if (n === 0) return { mean: NaN, half: Infinity, lo: -Infinity, hi: Infinity, n, sd: NaN };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  if (n < 2) return { mean, half: Infinity, lo: -Infinity, hi: Infinity, n, sd: NaN };
  let ss = 0;
  for (const x of xs) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / (n - 1));
  const half = sd === 0 ? 0 : (tQuantile((1 + level) / 2, n - 1) * sd) / Math.sqrt(n);
  return { mean, half, lo: mean - half, hi: mean + half, n, sd };
}

/** Paired CI of b − a: meanCI of the per-seed differences (common random numbers). */
export function pairedCI(a: readonly number[], b: readonly number[], level = 0.95): CI {
  if (a.length !== b.length) throw new Error('pairedCI needs equally many replicates');
  return meanCI(
    b.map((x, i) => x - a[i]!),
    level,
  );
}
