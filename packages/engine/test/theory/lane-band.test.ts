/**
 * Lane-band rule (docs/MODEL.md §2.2) on a lane-drop corridor (§2.6): W = 7 m, 2 lanes,
 * drop 1 lane at 300 m, taper 50 m ⇒ W2 = 3.5 m and the taper band fromLateral = [0, 3.5].
 *
 * A vehicle may enter the taper only with its body [y − width/2, y + width/2] ⊂ [0, 3.5];
 * otherwise the link end is a standing obstacle at offset L_up − s (speed 0).
 * Theory for the stopping vehicle (T3): IDM with ζ = T·√(a/(2 s0)) = 2·√(2/4) = 1.41 ≥ 1
 * approaches a standing obstacle without overshoot and settles to the gap s0 from above.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type ClassSpec, type M2Sim } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 2, s0: 2, a: 2, b: 2 }; // overdamped near the stop (ζ = 1.41)
const CLASSES: ClassSpec[] = [
  { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0.8, politeness: 0, threshold: 0.1 },
  // 3.6 m wide: can never lie inside a 3.5 m band, whatever it does laterally
  { id: 'truck', length: 9, width: 3.6, idm: IDM, c0: 0.2, c1: 0, maxLat: 0.8, politeness: 0, threshold: 0.1 },
];
const UP = 300;
const BAND: [number, number] = [0, 3.5];

function corridor(mode: 'strip' | 'lane'): M2Sim {
  return makeSim(
    corridorScenario({
      lengthM: 700,
      widthM: 7,
      lanes: 2,
      change: { kind: 'laneDrop', atM: UP, dropLanes: 1, taperM: 50 },
      mode,
    }),
    classSet(CLASSES),
  );
}

describe('lane-band rule (§2.2)', () => {
  it('premise: the taper band is [0, min(W, W2)] = [0, 3.5]', () => {
    const net = corridor('strip').network;
    const taper = net.movements.find((m) => m.id === 'taper')!;
    expect(taper.fromLateral).toEqual(BAND);
  });

  it('a vehicle that can never fit the band stops before the link end and stays on the link', () => {
    const sim = corridor('strip');
    sim.addVehicle({ classId: 'truck', link: 'up', s: 200, y: 5.0, v: 10 });
    for (let k = 0; k < 1500; k++) {
      sim.advance(1);
      const v = sim.vehicles()[0]!;
      expect(v.link).toBe('up');
      expect(v.s).toBeLessThan(UP); // the end is a standing obstacle: gap L_up − s > 0
      expect(v.v).toBeGreaterThanOrEqual(0);
    }
    const v = sim.vehicles()[0]!;
    // Settled (300 s ≫ the slow-mode time constant 1/k ≈ 1.7 s of the linearised approach):
    // at rest within 1e-6 and the gap to the end within 1e-6 of s0 (T3 derivation).
    expect(v.v).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(UP - v.s - IDM.s0)).toBeLessThanOrEqual(1e-6);
    expect(sim.counters().exited).toBe(0);
  });

  for (const mode of ['strip', 'lane'] as const) {
    it(`${mode} mode: a car starting outside the band moves into it and only then proceeds`, () => {
      const sim = corridor(mode);
      sim.addVehicle({ classId: 'car', link: 'up', s: 100, y: 5.25, v: 10 });
      const links: string[] = [];
      let checked = false;
      for (let k = 0; k < 2000 && sim.vehicleCount() > 0; k++) {
        sim.advance(1);
        const v = sim.vehicles()[0];
        if (!v) break;
        if (links[links.length - 1] !== v.link) {
          if (links[links.length - 1] === 'up') {
            // first observation past the end of 'up': the body was inside the band at transfer
            // (lateral motion after transfer only continues towards targetY, which is inside)
            expect(v.y - v.width / 2).toBeGreaterThanOrEqual(BAND[0] - 1e-9);
            expect(v.y + v.width / 2).toBeLessThanOrEqual(BAND[1] + 1e-9);
            checked = true;
          }
          links.push(v.link);
        }
        if (v.link === 'up') expect(v.s).toBeLessThanOrEqual(UP);
      }
      expect(checked).toBe(true);
      expect(links[0]).toBe('up');
      expect(links[links.length - 1]).toBe('down');
      expect(sim.counters().exited).toBe(1);
    });
  }
});
