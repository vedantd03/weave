/**
 * T15 follow-up: the saturation flow fitted at the signal (T15's slope) must equal the steady
 * discharge rate of a standing queue released on a plain link with the same road and class.
 * Webster's s is the queue-discharge rate at the stop line; without the junction the same
 * process is a standing queue released at its head. If the two differ, the junction is
 * reducing discharge, which is a defect.
 *
 * Plain link: corridor 'none', 3000 m, one 3.5 m lane, lane mode, speed limit 13.9 m/s (the
 * junction generator's default, so v0_eff = 12 m/s as at the junction). 150 cars of the T15
 * class are placed at rest with net gaps exactly s0 (IDM acceleration a(1 − (s0/s0)²) = 0 at
 * v = 0, so nobody moves until its leader does), head at 1500 m, with 1500 m of free road in
 * front. We record when each front crosses a line 200 m downstream of the head and take the
 * steady rate q = (n_b − n_a)/(t_b − t_a) over vehicles 30…130 (after the start-up transient).
 *
 * Tolerance (both runs deterministic):
 *  - plain rate: crossing instants are quantised to dt at both ends, so |q̂ − q| ≤ q·2dt/(t_b − t_a);
 *  - T15 slope: each per-cycle mean is within e = 1.2 veh/cycle of the affine model (T15), so
 *    the least-squares slope Σ(g_i − ḡ)y_i/Σ(g_i − ḡ)² is within e·Σ|g_i − ḡ|/Σ(g_i − ḡ)².
 * The sum of the two is the bound; it is not widened beyond that.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim } from '../helpers/m2.ts';
import { DT, E, GREENS, T15_CLASS, fit, log, perCycle } from '../helpers/signal-discharge.ts';

const LINE_OFFSET = 200;
const HEAD = 1500;
const N = 150;

function plainDischarge(): { rate: number; span: number } {
  const sim = makeSim(
    corridorScenario({ lengthM: 3000, widthM: 3.5, lanes: 1, mode: 'lane', speedLimitMps: 13.9 }),
    classSet([T15_CLASS]),
  );
  const spacing = T15_CLASS.length + T15_CLASS.idm.s0;
  const ids: number[] = [];
  for (let k = 0; k < N; k++) ids.push(sim.addVehicle({ classId: 'car', link: 'main', s: HEAD - k * spacing, y: 1.75, v: 0 }));
  const line = HEAD + LINE_OFFSET;
  const crossed = new Map<number, number>();
  for (let step = 0; step < Math.round(900 / DT) && crossed.size < N; step++) {
    sim.advance(1);
    for (const v of sim.vehicles()) if (!crossed.has(v.id) && v.s >= line) crossed.set(v.id, sim.t);
  }
  const a = 30;
  const b = 130;
  const ta = crossed.get(ids[a]!)!;
  const tb = crossed.get(ids[b]!)!;
  expect(ta).toBeDefined();
  expect(tb).toBeDefined();
  return { rate: (b - a) / (tb - ta), span: tb - ta };
}

describe('T15b plain-link discharge equals the signal saturation flow', () => {
  it('queue released on a plain link vs T15 fitted slope', { timeout: 180_000 }, () => {
    const plain = plainDischarge();
    const y = GREENS.map((g) => perCycle(g).mean);
    const { slope } = fit(GREENS, y);
    const mg = GREENS.reduce((s, g) => s + g, 0) / GREENS.length;
    const slopeBound = (E * GREENS.reduce((s, g) => s + Math.abs(g - mg), 0)) / GREENS.reduce((s, g) => s + (g - mg) ** 2, 0);
    const plainBound = (plain.rate * 2 * DT) / plain.span;
    log(
      `T15B plain_discharge=${plain.rate.toFixed(4)} veh/s (${(plain.rate * 3600).toFixed(0)} veh/h) ` +
        `signal_slope=${slope.toFixed(4)} veh/s (${(slope * 3600).toFixed(0)} veh/h) bound=${(slopeBound + plainBound).toFixed(4)}`,
    );
    expect(plain.rate).toBeGreaterThan(0.1);
    expect(Math.abs(slope - plain.rate)).toBeLessThanOrEqual(slopeBound + plainBound);
  });
});
