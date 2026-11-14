/**
 * T6 — determinism and random streams: Rng / mix32 / substream (MODEL.md §1.2), dln (§1.1),
 * Sim.stateHash (§1.7).
 *
 * Statistical checks use fixed seeds, so each passes or fails deterministically; thresholds are
 * set at ≥ 5σ (CLT) or p = 0.001 (chi-square) so a correct generator passes with overwhelming
 * margin while a broken one (bias, stuck bits, correlated substreams) fails.
 */
import { describe, expect, it } from 'vitest';
import { Purpose, Rng, mix32, substream } from '../../src/core/rng.ts';
import { dln } from '../../src/core/dmath.ts';
import { createSim } from '../../src/sim/sim.ts';
import { Z_999, chiSquareCritical, correlation, testPrng, ulp } from '../helpers/numeric.ts';
import { ringClassSet, ringScenario } from '../helpers/ring.ts';

const TWO32 = 4294967296;

function draws(r: Rng, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = r.next();
  return out;
}

describe('T6 Rng (xoshiro128**, MODEL.md §1.2)', () => {
  it('Purpose constants', () => {
    expect(Purpose).toEqual({ arrivals: 1, vehicle: 2, driver: 3, init: 4, gap: 5 });
  });

  it('same seed → same sequence; different seeds → different sequences', () => {
    const a = draws(new Rng(42), 1000);
    const b = draws(new Rng(42), 1000);
    const c = draws(new Rng(43), 1000);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // even seed 0 and the max uint32 give non-degenerate streams (splitmix32 seeding)
    for (const seed of [0, 0xffffffff]) {
      const xs = draws(new Rng(seed), 100);
      expect(new Set(xs).size).toBe(100);
    }
  });

  it('nextU32 is an integer in [0, 2^32); next() = nextU32()/2^32; uniform and exponential per formula', () => {
    const r1 = new Rng(2026);
    const r2 = new Rng(2026);
    for (let i = 0; i < 2000; i++) {
      const u = r1.nextU32();
      expect(Number.isInteger(u)).toBe(true);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(TWO32);
      expect(r2.next()).toBe(u / TWO32);
    }
    const r3 = new Rng(99);
    const r4 = new Rng(99);
    for (let i = 0; i < 1000; i++) {
      const lo = -3.5;
      const hi = 7.25;
      expect(r3.uniform(lo, hi)).toBe(lo + (hi - lo) * r4.next());
      const rate = 0.37;
      expect(r3.exponential(rate)).toBe(-dln(1 - r4.next()) / rate);
    }
  });

  it('next() lies in [0, 1); exponential() is finite and ≥ 0', () => {
    const r = new Rng(7);
    for (let i = 0; i < 100_000; i++) {
      const x = r.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
    const e = new Rng(8);
    for (let i = 0; i < 20_000; i++) {
      const x = e.exponential(3);
      expect(Number.isFinite(x) && x >= 0).toBe(true);
    }
  });

  it('chi-square uniformity of next() over 100 bins (p = 0.001 critical value)', () => {
    const n = 200_000;
    const k = 100;
    const counts = new Array<number>(k).fill(0);
    const r = new Rng(123456789);
    for (let i = 0; i < n; i++) counts[Math.floor(r.next() * k)]!++;
    const expected = n / k;
    let chi2 = 0;
    for (const c of counts) chi2 += ((c - expected) * (c - expected)) / expected;
    // df = k − 1 = 99; Wilson–Hilferty: χ²_0.999(99) ≈ 148.2.
    const crit = chiSquareCritical(k - 1, Z_999);
    expect(crit).toBeGreaterThan(140);
    expect(crit).toBeLessThan(155);
    expect(chi2).toBeLessThan(crit);
    // and not suspiciously perfect (lower p = 0.001 tail, χ² ≈ 61.9), which catches e.g.
    // a stratified/low-discrepancy sequence masquerading as random
    expect(chi2).toBeGreaterThan(chiSquareCritical(k - 1, -Z_999));
  });

  it('every bit of nextU32 is set with frequency 1/2 (5σ binomial bound)', () => {
    const n = 100_000;
    const ones = new Array<number>(32).fill(0);
    const r = new Rng(31337);
    for (let i = 0; i < n; i++) {
      const u = r.nextU32();
      for (let b = 0; b < 32; b++) if ((u >>> b) & 1) ones[b]!++;
    }
    // Bin(n, 1/2): σ = √n/2 ≈ 158; 5σ ≈ 791.
    const bound = 5 * (Math.sqrt(n) / 2);
    for (const c of ones) expect(Math.abs(c - n / 2)).toBeLessThan(bound);
  });

  it('exponential(rate): mean 1/rate and variance 1/rate² within 5σ CLT bounds', () => {
    const n = 200_000;
    const rate = 2.5;
    const r = new Rng(555);
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const x = r.exponential(rate);
      s += x;
      s2 += x * x;
    }
    const m = s / n;
    const v = s2 / n - m * m;
    // Exp(λ): σ = 1/λ, so sd(mean) = 1/(λ√n). Fourth central moment μ4 = 9/λ⁴, so
    // sd(sample variance) ≈ √((μ4 − σ⁴)/n) = √(8/n)/λ².
    expect(Math.abs(m - 1 / rate)).toBeLessThan(5 / (rate * Math.sqrt(n)));
    expect(Math.abs(v - 1 / (rate * rate))).toBeLessThan((5 * Math.sqrt(8 / n)) / (rate * rate));
  });
});

describe('T6 mix32 and substreams', () => {
  it('mix32 returns a deterministic uint32', () => {
    const g = testPrng(1);
    for (let i = 0; i < 1000; i++) {
      const a = Math.floor(g() * TWO32);
      const b = Math.floor(g() * 8);
      const c = Math.floor(g() * TWO32);
      const h = mix32(a, b, c);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(TWO32);
      expect(mix32(a, b, c)).toBe(h);
    }
  });

  it('mix32 avalanches: flipping one input bit flips 16 of 32 output bits on average', () => {
    // For an ideal hash each output bit flips with probability 1/2, so the number of flipped
    // bits is Bin(32, 1/2): mean 16, variance 8. Over M trials the mean has sd √(8/M);
    // we allow 5 sd. M = 100 inputs × 3 argument positions × 32 bits = 9600 → ±0.144.
    const g = testPrng(2);
    let total = 0;
    let M = 0;
    const popcount = (x: number) => {
      let c = 0;
      for (let b = 0; b < 32; b++) c += (x >>> b) & 1;
      return c;
    };
    for (let i = 0; i < 100; i++) {
      const args = [Math.floor(g() * TWO32), Math.floor(g() * TWO32), Math.floor(g() * TWO32)];
      const h = mix32(args[0]!, args[1]!, args[2]!);
      for (let pos = 0; pos < 3; pos++) {
        for (let b = 0; b < 32; b++) {
          const f = args.slice();
          f[pos] = (f[pos]! ^ (1 << b)) >>> 0;
          total += popcount((h ^ mix32(f[0]!, f[1]!, f[2]!)) >>> 0);
          M++;
        }
      }
    }
    expect(Math.abs(total / M - 16)).toBeLessThan(5 * Math.sqrt(8 / M));
  });

  it('substream(seed, p, e) is exactly new Rng(mix32(seed, p, e))', () => {
    for (const [seed, p, e] of [
      [0, 1, 0],
      [42, Purpose.vehicle, 7],
      [42, Purpose.driver, 7],
      [0xffffffff, Purpose.gap, 3 * 2 ** 20 + 17],
      [123, Purpose.init, 0],
    ] as [number, number, number][]) {
      const a = substream(seed, p, e);
      const b = new Rng(mix32(seed, p, e));
      for (let i = 0; i < 200; i++) expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('substreams are uncorrelated across entity, purpose and seed (|r| < 5/√n)', () => {
    // Under independence the sample correlation of n pairs is ≈ N(0, 1/n): 5σ = 5/√n.
    const n = 20_000;
    const bound = 5 / Math.sqrt(n);
    const base = draws(substream(42, Purpose.vehicle, 0), n);
    const others = [
      substream(42, Purpose.vehicle, 1), // neighbouring entity
      substream(42, Purpose.driver, 0), // other purpose, same entity
      substream(43, Purpose.vehicle, 0), // neighbouring seed
      substream(42, Purpose.vehicle, 2 ** 20), // first vehicle of origin 1
    ];
    for (const o of others) expect(Math.abs(correlation(base, draws(o, n)))).toBeLessThan(bound);
    // lag-1 autocorrelation within one stream
    expect(Math.abs(correlation(base.slice(0, n - 1), base.slice(1)))).toBeLessThan(5 / Math.sqrt(n - 1));
    // first draws across consecutive entities: uniform-looking, no shared prefix
    const firsts = new Set<number>();
    for (let e = 0; e < 1000; e++) firsts.add(substream(1, Purpose.vehicle, e).nextU32());
    expect(firsts.size).toBe(1000); // P(any collision among 1000 uint32) ≈ 1.2e-4
  });
});

describe('T6 dln (MODEL.md §1.1)', () => {
  it('special values', () => {
    expect(dln(-1)).toBeNaN();
    expect(dln(-Number.MIN_VALUE)).toBeNaN();
    expect(dln(-Infinity)).toBeNaN();
    expect(dln(NaN)).toBeNaN();
    expect(dln(0)).toBe(-Infinity);
    expect(dln(-0)).toBe(-Infinity); // −0 is not < 0 (IEEE log(−0) = −∞)
    expect(dln(Infinity)).toBe(Infinity);
    // ln 1 = 0; "within 1 ulp of 0" leaves only ±0 or the smallest subnormal
    expect(Math.abs(dln(1))).toBeLessThanOrEqual(Number.MIN_VALUE);
  });

  // fdlibm's split of ln 2: ln2_hi has 21 trailing zero bits, so k·ln2_hi is exact for
  // |k| ≤ 1074; ln2_hi + ln2_lo equals ln 2 to ~1e-27.
  const LN2_HI = 6.93147180369123816490e-1;
  const LN2_LO = 1.90821492927058770002e-10;

  it('powers of two (normal and subnormal): within 1 ulp of k·ln 2', () => {
    // E = fl(k·ln2_hi + k·ln2_lo) is the correctly rounded ln(2^k) (one rounding of a value
    // accurate to ~1e-23), so |E − ln| ≤ ½ ulp. dln within 1 ulp of ln ⇒ |dln − E| ≤ 1.5 ulp,
    // and since both are doubles, ≤ 1 ulp.
    // Build 2^k by exact doublings/halvings (Math.pow is not guaranteed exact by ECMAScript).
    const pow2 = new Map<number, number>([[0, 1]]);
    for (let k = 1, x = 1; k <= 1023; k++) pow2.set(k, (x *= 2));
    for (let k = -1, x = 1; k >= -1074; k--) pow2.set(k, (x /= 2));
    expect(pow2.get(-1074)).toBe(Number.MIN_VALUE);
    for (let k = -1074; k <= 1023; k++) {
      const x = pow2.get(k)!;
      const E = k * LN2_HI + k * LN2_LO;
      const got = dln(x);
      if (k === 0) expect(Math.abs(got)).toBeLessThanOrEqual(Number.MIN_VALUE);
      else expect(Math.abs(got - E)).toBeLessThanOrEqual(ulp(E));
    }
  });

  it('near 1: within 1 ulp of the series h − h²/2', () => {
    // x = 1 + h with |h| ≤ 2^-30 exactly representable; ln(1 + h) = h − h²/2 + h³/3 − …
    // fl(h − h·h/2) is within ½ ulp + |h³/3| of ln x, and |h³|/3 ≤ 2^-92 ≪ ½ ulp(h) ≈ 2^-83
    // for the largest h, so the 1-ulp bound for dln gives |dln − E| ≤ 1 ulp (as above).
    const hs: number[] = [];
    for (let j = 1; j <= 2000; j++) hs.push(j * 2 ** -52, -j * 2 ** -53);
    for (let k = 30; k <= 52; k++) hs.push(2 ** -k, -(2 ** -k));
    for (let k = 30; k <= 50; k++) hs.push(3 * 2 ** -(k + 2), -3 * 2 ** -(k + 3));
    for (const h of hs) {
      const x = 1 + h;
      expect(x - 1).toBe(h); // representable (test premise)
      const E = h - (h * h) / 2;
      expect(Math.abs(dln(x) - E)).toBeLessThanOrEqual(ulp(E));
    }
  });

  it('wide grid incl. subnormals and huge values: within 2 ulp of Math.log', () => {
    // dln is within 1 ulp of ln (spec); V8's Math.log is a port of fdlibm's __ieee754_log,
    // itself < 1 ulp. Triangle inequality ⇒ |dln − Math.log| ≤ 2 ulp (of the larger result).
    const g = testPrng(20261114);
    const xs: number[] = [Number.MIN_VALUE, Number.MAX_VALUE, 2.2250738585072014e-308, 2.225073858507201e-308];
    for (let e = -1074; e <= 1023; e += 1) {
      for (let k = 0; k < 12; k++) xs.push((1 + g()) * 2 ** e); // mantissa in [1, 2) (exactness of 2**e is irrelevant here)
    }
    for (let k = 0; k < 5000; k++) xs.push(Math.floor(g() * 2 ** 52 + 1) * Number.MIN_VALUE); // subnormals
    for (let k = 0; k < 5000; k++) xs.push(0.5 + g()); // [0.5, 1.5): around 1
    for (const x of xs) {
      if (!(x > 0) || !Number.isFinite(x)) continue;
      const ref = Math.log(x);
      const got = dln(x);
      const u = ulp(Math.max(Math.abs(ref), Math.abs(got)));
      expect(Math.abs(got - ref)).toBeLessThanOrEqual(2 * u);
    }
  });
});

describe('T6 Sim.stateHash determinism (MODEL.md §1.7)', () => {
  const P = { v0: 15, T: 1.2, s0: 2, a: 2, b: 2 };
  const make = (seed: number, jitterM = 2) =>
    createSim({
      scenario: ringScenario({ circumferenceM: 400, densityPerKm: 50, jitterM, seed }),
      classes: ringClassSet(P, 5),
    });

  it('same seed → identical hash and identical vehicles after N steps', () => {
    const a = make(2024);
    const b = make(2024);
    expect(a.stateHash()).toBe(b.stateHash());
    a.advance(500);
    b.advance(500);
    expect(typeof a.stateHash()).toBe('string');
    expect(a.stateHash()).toMatch(/^[0-9a-f]+$/i);
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.vehicles()).toEqual(b.vehicles());
  });

  it('advance(n) in one call or in chunks gives the same state', () => {
    const a = make(9);
    const b = make(9);
    a.advance(300);
    for (let i = 0; i < 3; i++) b.advance(100);
    expect(b.step).toBe(300);
    expect(a.stateHash()).toBe(b.stateHash());
    const c = make(9);
    for (let i = 0; i < 300; i++) c.advance(1);
    expect(c.stateHash()).toBe(a.stateHash());
  });

  it('different seeds with jitter > 0 → different hashes; the hash tracks the state', () => {
    const a = make(1);
    const b = make(2);
    expect(a.stateHash()).not.toBe(b.stateHash());
    a.advance(100);
    b.advance(100);
    expect(a.stateHash()).not.toBe(b.stateHash());
    const h100 = a.stateHash();
    a.advance(1);
    expect(a.stateHash()).not.toBe(h100);
  });

  it('with zero jitter the seed has no effect on a single-class fixed-size ring', () => {
    // Everything random in this scenario is the init jitter (fixed sizes, spread 0), so with
    // jitter 0 the states must coincide bit for bit.
    const a = make(1, 0);
    const b = make(2, 0);
    a.advance(50);
    b.advance(50);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});
