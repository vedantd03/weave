/**
 * Silk Board (the imported network, apps/web/public/data/silkboard.json): one simulated hour
 * with a modest OD over routable in/out zone pairs (chosen by a breadth-first search over
 * links → movements in the test). Every step: conservation (T11), no collisions (the M2
 * property invariant), speeds ≥ 0. At the end some trips have completed.
 */
import { describe, expect, it } from 'vitest';
import silk from '../../../../apps/web/public/data/silkboard.json' with { type: 'json' };
import { defaultClasses } from '../../src/index.ts';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { makeSim } from '../helpers/m2.ts';
import { collisions, reachableLinks } from '../helpers/m3.ts';

describe('Silk Board, one hour', () => {
  it('conservation and no collisions at every step; trips complete', { timeout: 600_000 }, () => {
    const net = Network.parse(silk);
    const outs = net.zones.filter((z) => z.role === 'out');
    const od: { origin: string; destination: string; rateVph: number }[] = [];
    for (const zi of net.zones.filter((z) => z.role === 'in')) {
      const reach = reachableLinks(net, zi.link);
      const zo = outs.find((o) => o.link !== zi.link && reach.has(o.link));
      if (zo && od.length < 6) od.push({ origin: zi.id, destination: zo.id, rateVph: 150 });
    }
    expect(od.length).toBeGreaterThanOrEqual(3);
    const scenario: ScenarioInput = {
      version: 1, id: 'silk', name: 'silk', network: { kind: 'file', id: 'silkboard' }, od,
      composition: { motorcycle: 0.56, car: 0.27, auto: 0.12, bus: 0.03, truck: 0.01, lcv: 0.01 },
      mode: 'strip', durationS: 3600, warmupS: 0, seed: 7,
    };
    const sim = makeSim(scenario, defaultClasses(), net);
    for (let k = 0; k < 18_000; k++) {
      sim.advance(1);
      const c = sim.counters();
      expect(c.generated).toBe(c.exited + c.onNetwork + c.entryQueue);
      const vs = sim.vehicles();
      expect(c.onNetwork).toBe(vs.length);
      expect(collisions(vs)).toEqual([]);
      for (const v of vs) expect(v.v).toBeGreaterThanOrEqual(0);
    }
    expect(sim.trips().length).toBeGreaterThan(0);
  });
});
