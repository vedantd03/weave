/**
 * T12 — Little's law L = λ·W on a link in steady state, from linkStats() differences
 * (docs/MODEL.md §2.7), plus the exact bookkeeping identity behind it.
 *
 * Estimator. After a warm-up, split the run into K windows of length Δ. In window k:
 *   L_k = ΔvehicleSeconds/Δ            (time-average number on the link)
 *   λ_k = Δentered/Δ                   (arrival rate to the link)
 *   W_k = ΔtravelTimeSum/ΔtravelTimeCount (mean time on the link of vehicles leaving in k)
 *   r_k = L_k − λ_k·W_k.
 * Within one window r_k differs from 0 only by boundary terms (time spent before the window by
 * vehicles leaving in it, time in the window of vehicles still present at its end, and
 * entered ≠ completed), which have zero mean in a stationary regime. So mean(r) = 0 and we test
 * it with a batch-means t interval: |mean r| ≤ t_{0.9995, K−1}·sd(r)/√K (two-sided p = 0.001).
 * Adjacent windows share boundaries with opposite signs (the sum telescopes), which makes the
 * batch variance an over-estimate of the variance of the mean: the interval is conservative.
 *
 * Identity. At any time t, every vehicle's time on the link is counted once:
 *   vehicleSeconds(t) = travelTimeSum(t) + Σ_{present} (t − t_enter),
 * up to the step discretisation of entry/exit instants (≤ dt per vehicle), and
 * entered − exited = number present, exited = travelTimeCount (every vehicle entered 'main').
 */
import { describe, expect, it } from 'vitest';
import { T_9995, classSet, corridorScenario, linkStat, makeSim } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };

describe('T12 Little\'s law on a corridor link', () => {
  it('batch means over 20 windows after warm-up, and the exact identity at the end', () => {
    const DT = 0.2;
    const sim = makeSim(
      corridorScenario({ lengthM: 500, widthM: 7, lanes: 2, rateVph: 1500, mode: 'lane', seed: 8 }),
      classSet([{ id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2 }]),
    );
    const WARMUP = 300;
    const K = 20;
    const WIN = 120;
    const tIn = new Map<number, number>();
    const observe = () => {
      for (const v of sim.vehicles()) if (v.link === 'main' && !tIn.has(v.id)) tIn.set(v.id, sim.t);
    };
    for (let k = 0; k < WARMUP / DT; k++) {
      sim.advance(1);
      observe();
    }
    const rows: ReturnType<typeof linkStat>[] = [{ ...linkStat(sim, 'main') }];
    for (let w = 0; w < K; w++) {
      for (let k = 0; k < WIN / DT; k++) {
        sim.advance(1);
        observe();
      }
      rows.push({ ...linkStat(sim, 'main') });
    }
    const r: number[] = [];
    let Lsum = 0;
    for (let w = 1; w <= K; w++) {
      const a = rows[w - 1]!;
      const b = rows[w]!;
      const L = (b.vehicleSeconds - a.vehicleSeconds) / WIN;
      const lam = (b.entered - a.entered) / WIN;
      const n = b.travelTimeCount - a.travelTimeCount;
      expect(n).toBeGreaterThan(20); // ~50 vehicles per window
      const W = (b.travelTimeSum - a.travelTimeSum) / n;
      r.push(L - lam * W);
      Lsum += L;
    }
    const mean = r.reduce((x, y) => x + y, 0) / K;
    const sd = Math.sqrt(r.reduce((x, y) => x + (y - mean) * (y - mean), 0) / (K - 1));
    expect(Lsum / K).toBeGreaterThan(5); // a non-trivial occupancy (~ λ·W ≈ 0.42·34 ≈ 14)
    expect(Math.abs(mean)).toBeLessThanOrEqual((T_9995[K - 1]! * sd) / Math.sqrt(K) + 1e-9);

    // identity at the final time
    const s = linkStat(sim, 'main');
    const present = sim.vehicles().filter((v) => v.link === 'main');
    expect(s.entered - s.exited).toBe(present.length);
    expect(s.exited).toBe(s.travelTimeCount);
    const ages = present.reduce((acc, v) => acc + (sim.t - tIn.get(v.id)!), 0);
    const slack = (s.travelTimeCount + present.length) * DT + 1e-6;
    expect(Math.abs(s.vehicleSeconds - s.travelTimeSum - ages)).toBeLessThanOrEqual(slack);
  });
});
