/**
 * §2.2 deadlock breaker (rerouting). A vehicle stopped (v < 0.1 m/s) within s0 + 1 m of the end
 * of a link because its body is outside the next movement's band, for REROUTE_AFTER_S = 20 s,
 * switches to the movement from that link whose effective band its body overlaps best and is
 * routed from that movement's toLink to its destination (§2.1); if the destination is
 * unreachable, to the nearest reachable exit (a diversion). diagnostics() counts reroutes and
 * diversions.
 *
 * Construction: link a (7 m, 2 lanes) splits at n1 into ab (band [0, 3.5]) and ac (band
 * [3.5, 7]). An added car takes the default route (first movement: ab) but sits at y = 5.25,
 * entirely inside ac's band, and its class has maxSpeedMps = 0 so it can never move laterally:
 * it stops at the end of a and stays out of ab's band. Its body overlaps ac's band fully and
 * ab's not at all, so the reroute must take ac.
 *  - "parallel": b and c both lead to d (its destination stays reachable: no diversion);
 *  - "diverge": b and c are separate exits; demand vehicles bound for b that end up on the right
 *    are rerouted to c, from where b is unreachable: a diversion to c's exit. (Added vehicles
 *    have no destination zone, so the diversion case uses demand.)
 * Timing tolerance: the stuck condition and the reroute are both evaluated once per step, and
 * the engine may evaluate on the pre-step snapshot, so the reroute step lies within
 * [stuck + 20 − dt, stuck + 20 + 2·dt] of the first post-step state that satisfies the
 * condition.
 */
import { describe, expect, it } from 'vitest';
import { Network, type ScenarioInput } from '../../src/schema/index.ts';
import { classSet, makeSim, type ClassSpec } from '../helpers/m2.ts';
import { ARM, junctionScenario, type M3Sim } from '../helpers/m3.ts';

const DT = 0.2;
const REROUTE_AFTER_S = 20;
const IDM = { v0: 12, T: 2, s0: 2, a: 2, b: 2 }; // ζ = 1.41: settles at gap s0 without overshoot
const STUCK_CAR: ClassSpec = { id: 'car', length: 4.5, width: 1.8, idm: IDM, c0: 0.2, c1: 0, maxLat: 0 };
type P = [number, number];
const L_A = 300;

function net(kind: 'parallel' | 'diverge'): Network {
  const link = (id: string, from: string, to: string, pl: P[], w: number, lanes = 1) => ({ id, from, to, polyline: pl, widthM: w, lanes, speedLimitMps: 13 });
  const mv = (id: string, node: string, fromLink: string, toLink: string, path: P[], fromLateral: P, w = 3.5) => ({
    id, node, fromLink, toLink, path, widthM: w, fromLateral, toLateral: [0, w] as P, control: 'free' as const,
  });
  const parallel = kind === 'parallel';
  return Network.parse({
    version: 1, id: kind, name: kind,
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: parallel ? 'boundary' : 'plain' }, { id: 'n1', x: L_A, y: 0, kind: 'diverge' },
      ...(parallel ? [] : [{ id: 'nu', x: -200, y: 0, kind: 'boundary' as const }]),
      { id: 'n2', x: 600, y: 0, kind: parallel ? 'merge' : 'boundary' },
      ...(parallel ? [{ id: 'n3', x: 805, y: 0, kind: 'boundary' as const }] : [{ id: 'n4', x: 600, y: -100, kind: 'boundary' as const }]),
    ],
    links: [
      link('a', 'n0', 'n1', [[0, -3.5], [L_A, -3.5]], 7, 2),
      ...(parallel ? [] : [link('up0', 'nu', 'n0', [[-200, -3.5], [-5, -3.5]], 7, 2)]),
      link('b', 'n1', 'n2', [[305, -1.75], [parallel ? 595 : 600, -1.75]], 3.5),
      link('c', 'n1', parallel ? 'n2' : 'n4', parallel ? [[305, -5.25], [450, -60], [595, -5.25]] : [[305, -5.25], [600, -100]], 3.5),
      ...(parallel ? [link('d', 'n2', 'n3', [[600, -1.75], [800, -1.75]], 3.5)] : []),
    ],
    movements: [
      mv('ab', 'n1', 'a', 'b', [[L_A, -1.75], [305, -1.75]], [0, 3.5]),
      mv('ac', 'n1', 'a', 'c', [[L_A, -5.25], [305, -5.25]], [3.5, 7]),
      // m0 feeds only the right half of a: demand vehicles insert there (band-only insertion,
      // §2.3) with their bodies fully inside ac's band, but are routed to b through ab
      ...(parallel ? [] : [{ ...mv('m0', 'n0', 'up0', 'a', [[-5, -5.25], [0, -5.25]], [3.5, 7]), toLateral: [3.5, 7] as P }]),
      ...(parallel
        ? [mv('bd', 'n2', 'b', 'd', [[595, -1.75], [600, -1.75]], [0, 3.5]), mv('cd', 'n2', 'c', 'd', [[595, -5.25], [600, -1.75]], [0, 3.5])]
        : []),
    ],
    zones: parallel
      ? [{ id: 'in', link: 'a', role: 'in' }, { id: 'out', link: 'd', role: 'out' }]
      : [{ id: 'in', link: 'up0', role: 'in' }, { id: 'out1', link: 'b', role: 'out' }, { id: 'out2', link: 'c', role: 'out' }],
  });
}

const scenario = (id: string): ScenarioInput => ({
  version: 1, id, name: id, network: { kind: 'custom', id }, od: [], composition: { car: 1 },
  mode: 'strip', stripWidthM: 0.25, durationS: 3600, warmupS: 0, seed: 1,
});

interface Run {
  stuckAt: number;
  reroutedAt: number;
  links: string[];
  exited: boolean;
  reroutes: number;
  diversions: number;
}

function run(kind: 'parallel' | 'diverge', y: number, steps = 1500): Run {
  const sim = makeSim(scenario(kind), classSet([STUCK_CAR]), net(kind)) as unknown as M3Sim;
  const id = sim.addVehicle({ classId: 'car', link: 'a', s: 200, y, v: 10 });
  let stuckAt = -1;
  let reroutedAt = -1;
  const links: string[] = [];
  let exited = false;
  for (let k = 0; k < steps; k++) {
    sim.advance(1);
    const c = sim.counters();
    expect(c.generated).toBe(c.exited + c.onNetwork + c.entryQueue);
    const d = sim.diagnostics() as unknown as { reroutes: number; diversions: number };
    const v = sim.vehicles().find((x) => x.id === id);
    if (!v) {
      exited = true;
      break;
    }
    if (links[links.length - 1] !== v.link) links.push(v.link);
    const outOfAb = v.y - v.width / 2 < 0 || v.y + v.width / 2 > 3.5;
    if (stuckAt < 0 && v.link === 'a' && v.v < 0.1 && L_A - v.s <= IDM.s0 + 1 && outOfAb) stuckAt = sim.t;
    if (reroutedAt < 0 && d.reroutes > 0) reroutedAt = sim.t;
    if (stuckAt >= 0 && reroutedAt < 0) expect(sim.t - stuckAt).toBeLessThan(REROUTE_AFTER_S + 2 * DT + 1e-9);
  }
  const d = sim.diagnostics() as unknown as { reroutes: number; diversions: number };
  return { stuckAt, reroutedAt, links, exited, reroutes: d.reroutes, diversions: d.diversions };
}

describe('§2.2 deadlock breaker (rerouting)', () => {
  it('stuck out of band: no reroute before 20 s, reroute after; takes ac and reaches its destination (no diversion)', () => {
    const r = run('parallel', 5.25);
    expect(r.stuckAt).toBeGreaterThan(0);
    expect(r.reroutedAt).toBeGreaterThanOrEqual(r.stuckAt + REROUTE_AFTER_S - DT - 1e-9);
    expect(r.reroutedAt).toBeLessThanOrEqual(r.stuckAt + REROUTE_AFTER_S + 2 * DT + 1e-9);
    expect(r.reroutes).toBe(1);
    expect(r.diversions).toBe(0);
    expect(r.links).toEqual(['a', 'ac', 'c', 'cd', 'd']);
    expect(r.exited).toBe(true);
  });

  it('destination unreachable after the switch: diverted to the nearest reachable exit and counted', () => {
    // Demand in → out1 (on b). Vehicles insert on up0, whose next movement m0 has band [3.5, 7]
    // (band-only insertion, §2.3), so on a they sit fully inside ac's band; they cannot move left
    // (maxSpeedMps = 0), stop at the end and are rerouted to ac → c, from where out1 is
    // unreachable: every reroute is a diversion, to out2.
    const sc: ScenarioInput = { ...scenario('diverge'), od: [{ origin: 'in', destination: 'out1', rateVph: 300 }] };
    const sim = makeSim(sc, classSet([STUCK_CAR]), net('diverge')) as unknown as M3Sim;
    const seenOnC = new Set<number>();
    let onB = 0;
    for (let k = 0; k < 3000; k++) {
      sim.advance(1);
      const c = sim.counters();
      expect(c.generated).toBe(c.exited + c.onNetwork + c.entryQueue);
      for (const v of sim.vehicles()) {
        if (v.link === 'ac' || v.link === 'c') seenOnC.add(v.id);
        if (v.link === 'ab' || v.link === 'b') onB++;
      }
    }
    const d = sim.diagnostics() as unknown as { reroutes: number; diversions: number };
    expect(d.reroutes).toBeGreaterThanOrEqual(3); // one per vehicle reaching the end, every ≥ 20 s
    expect(d.diversions).toBe(d.reroutes);
    expect(onB).toBe(0);
    // only rerouted vehicles use ac / c (one rerouted in the last steps may still be on a)
    expect(seenOnC.size).toBeLessThanOrEqual(d.reroutes);
    expect(seenOnC.size).toBeGreaterThanOrEqual(d.reroutes - 1);
    // c is ~310 m (≈ 26 s at v0 = 12 m/s) and reroutes are ≥ 20 s apart (each needs a new 20 s
    // stall), so at most two diverted vehicles can still be travelling at the end
    expect(sim.counters().exited).toBeGreaterThanOrEqual(d.reroutes - 2);
  });

  it('a vehicle that fits its band is never rerouted', () => {
    const r = run('parallel', 1.75); // body [0.85, 2.65] ⊂ ab's band [0, 3.5]
    expect(r.stuckAt).toBe(-1);
    expect(r.reroutes).toBe(0);
    expect(r.links).toEqual(['a', 'ab', 'b', 'bd', 'd']);
    expect(r.exited).toBe(true);
  });

  it('a vehicle that fits its band but waits at a red light for minutes is never rerouted', () => {
    // generated 4-arm junction, one lane per arm (band [0, 3.5]); a plan whose only phase
    // protects nothing keeps every approach red forever
    const arms = [ARM(0), ARM(90), ARM(180), ARM(270)];
    const classes = classSet([{ id: 'car', length: 4.5, width: 1.8, idm: IDM }]);
    const node = makeSim(junctionScenario({ arms }), classes).network.signals[0]!.node;
    const sim = makeSim(
      junctionScenario({ arms, signalOverrides: [{ node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: 60, protected: [] }] }] }),
      classes,
    ) as unknown as M3Sim;
    sim.addVehicle({ classId: 'car', link: 'arm0_in', s: 150, y: 1.75, v: 10 });
    sim.advance(Math.round(180 / DT));
    const v = sim.vehicles()[0]!;
    expect(v.link).toBe('arm0_in');
    expect(v.v).toBeLessThan(0.1);
    expect((sim.diagnostics() as unknown as { reroutes: number }).reroutes).toBe(0);
  });
});
