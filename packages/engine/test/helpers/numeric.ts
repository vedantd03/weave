/** Test-local numeric utilities (no engine code). */

export const EPS = Number.EPSILON; // 2^-52, the spacing of doubles just above 1

/**
 * Unit in the last place of x: the gap from |x| to the next larger double (for MAX_VALUE, the
 * gap to the next smaller one). ulp(0) is the smallest subnormal.
 */
export function ulp(x: number): number {
  const ax = Math.abs(x);
  if (Number.isNaN(ax) || ax === Infinity) return NaN;
  if (ax === 0) return Number.MIN_VALUE;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, ax);
  const bits = dv.getBigUint64(0);
  dv.setBigUint64(0, bits + 1n);
  const up = dv.getFloat64(0);
  if (up !== Infinity) return up - ax;
  dv.setBigUint64(0, bits - 1n);
  return ax - dv.getFloat64(0);
}

/**
 * Small deterministic PRNG for building test grids (mulberry32). Deliberately NOT the engine's
 * Rng, so test inputs never depend on the code under test.
 */
export function testPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Upper 0.001 quantile of the standard normal, z_{0.999} = 3.090232306 (standard tables). */
export const Z_999 = 3.090232306167813;

/**
 * Wilson–Hilferty (1931) approximation of the chi-square quantile with k degrees of freedom:
 *   chi2_p(k) ≈ k (1 − 2/(9k) + z_p sqrt(2/(9k)))^3.
 * Relative error < 0.1% for k ≥ 30 at p = 0.999 (Johnson, Kotz & Balakrishnan, Continuous
 * Univariate Distributions vol. 1, ch. 18), far smaller than the margin our tests rely on.
 */
export function chiSquareCritical(k: number, z: number): number {
  const h = 2 / (9 * k);
  const t = 1 - h + z * Math.sqrt(h);
  return k * t * t * t;
}

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population standard deviation. */
export function stdDev(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** Pearson correlation of two equal-length samples. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Wrap d into [0, L). */
export function wrap(d: number, L: number): number {
  const r = d % L;
  return r < 0 ? r + L : r;
}
