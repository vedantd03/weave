/**
 * T11 — vehicle conservation (docs/MODEL.md §2.7): generated = exited + onNetwork + entryQueue
 * exactly, at every step, and onNetwork = vehicleCount(). Initial vehicles count as generated.
 */
import { describe, expect, it } from 'vitest';
import { classSet, corridorScenario, makeSim, type ClassSpec } from '../helpers/m2.ts';

const IDM = { v0: 15, T: 1.2, s0: 2, a: 1.5, b: 2 };
const SPECS: ClassSpec[] = [
  { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2 },
  { id: 'motorcycle', length: 2, width: 0.8, idm: { ...IDM, v0: 16 }, c0: 0.15 },
  { id: 'bus', length: 11, width: 2.5, idm: { ...IDM, v0: 12, T: 1.8, a: 1 }, c0: 0.3 },
];

describe('T11 conservation', () => {
  for (const mode of ['strip', 'lane'] as const) {
    it(`${mode} mode, congested lane-drop corridor: holds at every step for 600 s`, () => {
      const sim = makeSim(
        corridorScenario({
          lengthM: 600,
          widthM: 7,
          lanes: 2,
          change: { kind: 'laneDrop', atM: 300, dropLanes: 1, taperM: 50 },
          rateVph: 2500, // above the downstream single-lane capacity: queues form
          mode,
          composition: { car: 0.6, motorcycle: 0.3, bus: 0.1 },
          initialDensityPerKm: 20,
          seed: 12,
        }),
        classSet(SPECS),
      );
      const c0 = sim.counters();
      // initial placement: round(20·L/1000) per link: up 300 m → 6, down 600 − 350 = 250 m → 5
      expect(c0.generated).toBe(11);
      expect(c0.onNetwork).toBe(11);
      expect(c0.exited + c0.entryQueue).toBe(0);
      for (let k = 0; k < 3000; k++) {
        sim.advance(1);
        const c = sim.counters();
        expect(c.generated).toBe(c.exited + c.onNetwork + c.entryQueue);
        expect(c.onNetwork).toBe(sim.vehicleCount());
      }
      const c = sim.counters();
      expect(c.exited).toBeGreaterThan(0);
      expect(c.generated).toBeGreaterThan(11);
    });
  }
});
