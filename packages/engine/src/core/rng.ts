import { dln } from './dmath.ts';

/**
 * Seeded random streams (docs/MODEL.md §1.2): xoshiro128** seeded by splitmix32, with
 * per-(purpose, entity) substreams for common random numbers. Pure uint32 arithmetic.
 */

const imul = Math.imul;

export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Avalanche hash of uint32 inputs → uint32. */
export function mix32(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) h = fmix32(((h ^ (v >>> 0)) + 0x9e3779b9) >>> 0);
  return h;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

const TWO32 = 4294967296;

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x9e3779b9) >>> 0;
      return fmix32(state);
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform integer in [0, 2^32). */
  nextU32(): number {
    const r = imul(rotl(imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return r;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / TWO32;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Exponential with the given rate (mean 1/rate). */
  exponential(rate: number): number {
    return -dln(1 - this.next()) / rate;
  }
}

export const Purpose = { arrivals: 1, vehicle: 2, driver: 3, init: 4, gap: 5 } as const;

export function substream(seed: number, purpose: number, entity: number): Rng {
  return new Rng(mix32(seed, purpose, entity));
}
