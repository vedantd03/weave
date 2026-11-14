/**
 * T21 — common random numbers (docs/MODEL.md §1.2, §2.1, ADR-007): what is drawn for a vehicle
 * depends only on (seed, purpose, entity). Toggling the flyover or changing a signal plan must
 * leave every generated vehicle's (id, tGen, origin, destination, class, length, width, driver
 * parameters) bit-identical: zone ids and in-zone order are stable (§3.5), and the arrival,
 * vehicle and driver substreams never see the network's downstream structure.
 * Classes: the calibrated defaultClasses() with spread 0.2 put on every IDM parameter so the
 * driver substream is exercised (quantile sizes exercise the vehicle substream).
 */
import { describe, expect, it } from 'vitest';
import { defaultClasses } from '../../src/index.ts';
import { ClassSet } from '../../src/schema/index.ts';
import { makeSim, type GenRecord } from '../helpers/m2.ts';
import { junctionScenario, type Arm } from '../helpers/m3.ts';

const arms: Arm[] = [0, 90, 180, 270].map((a) => ({ angleDeg: a, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 }));
const fly = { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 120, heightM: 6.5 };
const od: { origin: string; destination: string; rateVph: number }[] = [];
for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) if (i !== k) od.push({ origin: `arm${i}_in`, destination: `arm${k}_out`, rateVph: 150 });
const composition = { motorcycle: 0.56, car: 0.27, auto: 0.12, bus: 0.03, truck: 0.01, lcv: 0.01 };

function spreadClasses(): ClassSet {
  const base = JSON.parse(JSON.stringify(defaultClasses())) as ClassSet;
  for (const c of base.classes) for (const k of ['v0', 'T', 's0', 'a', 'b'] as const) c.idm[k].spread = 0.2;
  return ClassSet.parse(base);
}
const view = (r: GenRecord) => [r.id, r.tGen, r.origin, r.destination, r.classId, r.length, r.width, r.v0, r.T, r.s0, r.a, r.b];

function log(opts: { flyover?: boolean; overrides?: (node: string, from: (k: number) => string[]) => unknown[] }): GenRecord[] {
  const classes = spreadClasses();
  const sc = junctionScenario({ arms, od, composition, mode: 'strip', seed: 2121, ...(opts.flyover ? { flyover: fly } : {}) });
  let overrides: unknown[] = [];
  if (opts.overrides) {
    const net = makeSim(sc, classes).network;
    const from = (k: number) => net.movements.filter((m) => m.fromLink === `arm${k}_in`).map((m) => m.id);
    overrides = opts.overrides(net.signals[0]!.node, from);
  }
  const sim = makeSim({ ...sc, signalOverrides: overrides as never }, classes);
  sim.advance(3000); // 600 s
  return sim.generatedLog();
}

describe('T21 common random numbers', () => {
  const base = log({});

  it('premise: a non-trivial generation log with driver variation', () => {
    expect(base.length).toBeGreaterThan(200); // λT = 12·150/3600·600 = 300
    expect(new Set(base.map((r) => r.v0)).size).toBeGreaterThan(10);
  });

  it('toggling the flyover leaves every generated vehicle bit-identical', () => {
    expect(log({ flyover: true }).map(view)).toEqual(base.map(view));
  });

  it('changing the signal plan leaves every origin\'s arrival sequence bit-identical', () => {
    const changed = log({
      overrides: (node, from) => [
        { node, amberS: 4, allRedS: 1, offsetS: 13, phases: [0, 1, 2, 3].map((k) => ({ greenS: 15 + 7 * k, protected: from(k) })) },
      ],
    });
    expect(changed.map(view)).toEqual(base.map(view));
  });
});
