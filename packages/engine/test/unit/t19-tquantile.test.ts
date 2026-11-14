/**
 * T19 — Student-t quantile (docs/MODEL.md §5.1): tQuantile(p, df) accurate to 1e-6 for df ≥ 1,
 * p ∈ (0.5, 0.9999).
 *
 * Expected values come from an independent reference (helpers/stats-ref.ts): the exact finite
 * series for the t CDF of Abramowitz & Stegun 26.7.3/26.7.4, inverted by bisection to
 * 1e-13·max(1, t). The reference error is ~1e-12 relative, far below the spec's 1e-6, so the
 * tolerance is the spec's: 1e-6, applied relative to max(1, |t|) (for df = 1, p = 0.9995,
 * t ≈ 636.6, where an absolute 1e-6 would ask for 15 significant digits).
 * Closed forms are checked too: df = 1, t = tan(π(p − ½)); df = 2, t = (2p − 1)·√(2/(1 − (2p − 1)²)).
 * Table spot values (e.g. t₀.₉₇₅,₁₀ = 2.228139, t₀.₉₉₅,₅ = 4.032143, t₀.₉₉₉₅,₄ = 8.610302) guard the
 * reference itself.
 */
import { describe, expect, it } from 'vitest';
import { tQuantile } from '../../src/stats/tdist.ts';
import { tCdfRef, tQuantileRef } from '../helpers/stats-ref.ts';

const DFS = [1, 2, 3, 4, 5, 9, 19, 29, 99];
const PS = [0.9, 0.95, 0.975, 0.995, 0.9995];
const tol = (t: number) => 1e-6 * Math.max(1, Math.abs(t));

describe('T19 tQuantile', () => {
  it('reference sanity: closed forms and published table values', () => {
    for (const p of PS) {
      expect(Math.abs(tQuantileRef(p, 1) - Math.tan(Math.PI * (p - 0.5)))).toBeLessThan(1e-9 * Math.tan(Math.PI * (p - 0.5)));
      const q = 2 * p - 1;
      expect(Math.abs(tQuantileRef(p, 2) - q * Math.sqrt(2 / (1 - q * q)))).toBeLessThan(1e-9);
    }
    // Student-t tables (e.g. Abramowitz & Stegun table 26.10), 6 decimals
    expect(tQuantileRef(0.975, 10)).toBeCloseTo(2.228139, 6);
    expect(tQuantileRef(0.995, 5)).toBeCloseTo(4.032143, 6);
    expect(tQuantileRef(0.9995, 4)).toBeCloseTo(8.610302, 6);
    expect(tQuantileRef(0.975, 99)).toBeCloseTo(1.984217, 6);
    expect(tCdfRef(0, 7)).toBe(0.5);
  });

  for (const df of DFS) {
    it(`df = ${df}: all p within 1e-6·max(1, t) of the reference`, () => {
      for (const p of PS) {
        const ref = tQuantileRef(p, df);
        expect(Math.abs(tQuantile(p, df) - ref), `p = ${p}`).toBeLessThanOrEqual(tol(ref));
      }
    });
  }

  it('monotone in p and decreasing in df (toward the normal quantile)', () => {
    for (const df of DFS) {
      let prev = 0;
      for (const p of [0.6, 0.7, 0.8, ...PS, 0.9999]) {
        const t = tQuantile(p, df);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
    }
    for (let i = 1; i < DFS.length; i++) expect(tQuantile(0.975, DFS[i]!)).toBeLessThan(tQuantile(0.975, DFS[i - 1]!));
  });
});
