/**
 * Junction behaviour with exact expectations (docs/MODEL.md §3.4):
 *  - RED: the stop line is a standing obstacle → the vehicle stops before it (gap > 0) and,
 *    with ζ = T·√(a/(2 s0)) = 1.41 ≥ 1, settles at gap s0 (T3 argument).
 *  - Commitment: once its front has crossed the stop line, a vehicle ignores the signal and
 *    proceeds through red to the movement's toLink.
 *  - Don't block the box (rule 5): with boxCompliance = 1 a vehicle enters m only if m's toLink
 *    has space ≥ length + s0, so once the toLink is full nobody stops inside m; with
 *    boxCompliance = 0 nobody obeys (u₃ < 0 never holds) and vehicles queue inside m.
 */
import { describe, expect, it } from 'vitest';
import { Network } from '../../src/schema/index.ts';
import { classSet, makeSim } from '../helpers/m2.ts';
import { ARM, armLinks, junctionScenario } from '../helpers/m3.ts';

const ARMS = [ARM(0, 3.5, 1, 250), ARM(90, 3.5, 1, 250), ARM(180, 3.5, 1, 250), ARM(270, 3.5, 1, 250)];
const CLASSES = classSet([
  { id: 'car', length: 4.5, width: 1.8, idm: { v0: 12, T: 2, s0: 2, a: 2, b: 2 } }, // ζ = 1.41
  { id: 'auto', length: 3, width: 1.4, idm: { v0: 2, T: 1, s0: 1, a: 1, b: 1.5 } }, // slow
  { id: 'truck', length: 9, width: 3.2, idm: { v0: 10, T: 2, s0: 2, a: 1, b: 2 } },
]);

function junction(phases: (from: (k: number) => string[], order: number[]) => { greenS: number; protected: string[] }[]) {
  const net = makeSim(junctionScenario({ arms: ARMS }), CLASSES).network;
  const links = armLinks(net);
  const order = [...links.keys()].sort((x, y) => x - y);
  const from = (k: number) => net.movements.filter((m) => m.fromLink === links.get(k)!.inLink).map((m) => m.id);
  const node = net.signals[0]!.node;
  const sim = makeSim(
    junctionScenario({ arms: ARMS, signalOverrides: [{ node, amberS: 3, allRedS: 2, offsetS: 0, phases: phases(from, order) }] }),
    CLASSES,
  );
  return { sim, links, order, net };
}

describe('signals in the simulation', () => {
  it('RED: a vehicle stops before the stop line and settles at gap s0', () => {
    // arm 0 never gets a phase → its movements are always RED
    const { sim, links, order } = junction((from, o) => o.slice(1).map((k) => ({ greenS: 20, protected: from(k) })));
    const inLink = links.get(order[0]!)!.inLink;
    const L = 250;
    sim.addVehicle({ classId: 'car', link: inLink, s: 130, v: 10, y: 1.75 });
    for (let k = 0; k < 1000; k++) {
      sim.advance(1);
      const v = sim.vehicles()[0]!;
      expect(v.link).toBe(inLink);
      expect(v.s).toBeLessThan(L);
    }
    const v = sim.vehicles()[0]!;
    expect(v.v).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(L - v.s - 2)).toBeLessThanOrEqual(1e-6);
  });

  it('commitment: a vehicle past its stop line proceeds through red', () => {
    // arm 0 green only for t ∈ [0, 2) s, then amber, all-red and a 60 s phase for arm 1
    const { sim, links, order, net } = junction((from, o) => [
      { greenS: 2, protected: from(o[0]!) },
      { greenS: 60, protected: from(o[1]!) },
    ]);
    const inLink = links.get(order[0]!)!.inLink;
    // 1 m before the stop line at 2 m/s: crosses during green (≈ 0.5 s)
    sim.addVehicle({ classId: 'auto', link: inLink, s: 249, v: 2, y: 1.75 });
    const mv = net.movements.find((m) => m.fromLink === inLink)!; // default route: first movement
    let onMovementDuringRed = false;
    let reached = false;
    for (let k = 0; k < 600 && !reached; k++) {
      sim.advance(1);
      const v = sim.vehicles()[0];
      if (!v) break;
      if (v.link === mv.id && sim.t >= 5 + 1e-9) onMovementDuringRed = true;
      if (v.link === mv.toLink) reached = true;
    }
    expect(onMovementDuringRed).toBe(true); // premise: it really was inside the box during red
    expect(reached).toBe(true);
  });
});

describe("don't block the box", () => {
  // a (300 m) → m (free, 30 m box) → b (60 m) → m2 (free, band [0, 3.0]) → c (width 3.0).
  // A 3.2 m truck placed on b can never enter m2 (§2.2), so b fills up behind it.
  // n1 also has a side branch a → mside → side (exit zone out_side, no demand routed to it), so
  // n1 is a junction (≥ 2 movements) and rule 5 applies to m (§3.4 item 5, junction nodes only).
  type P = [number, number];
  const net = Network.parse({
    version: 1, id: 'box', name: 'box',
    nodes: [
      { id: 'n0', x: 0, y: 0, kind: 'boundary' }, { id: 'n1', x: 300, y: 0, kind: 'plain' },
      { id: 'n2', x: 390, y: 0, kind: 'plain' }, { id: 'n3', x: 600, y: 0, kind: 'boundary' },
      { id: 'n4', x: 330, y: -60, kind: 'boundary' },
    ],
    links: [
      { id: 'a', from: 'n0', to: 'n1', polyline: [[0, 0], [300, 0]] as P[], widthM: 3.5, lanes: 1, speedLimitMps: 13 },
      { id: 'b', from: 'n1', to: 'n2', polyline: [[330, 0], [390, 0]] as P[], widthM: 3.5, lanes: 1, speedLimitMps: 13 },
      { id: 'c', from: 'n2', to: 'n3', polyline: [[392, 0], [600, 0]] as P[], widthM: 3.0, lanes: 1, speedLimitMps: 13 },
      { id: 'side', from: 'n1', to: 'n4', polyline: [[310, -10], [330, -60]] as P[], widthM: 3.5, lanes: 1, speedLimitMps: 13 },
    ],
    movements: [
      { id: 'm', node: 'n1', fromLink: 'a', toLink: 'b', path: [[300, 0], [330, 0]] as P[], widthM: 3.5, fromLateral: [0, 3.5] as P, toLateral: [0, 3.5] as P, control: 'free' },
      { id: 'm2', node: 'n2', fromLink: 'b', toLink: 'c', path: [[390, 0], [392, 0]] as P[], widthM: 3.0, fromLateral: [0, 3.0] as P, toLateral: [0, 3.0] as P, control: 'free' },
      { id: 'mside', node: 'n1', fromLink: 'a', toLink: 'side', path: [[300, 0], [310, -10]] as P[], widthM: 3.5, fromLateral: [0, 3.5] as P, toLateral: [0, 3.5] as P, control: 'free' },
    ],
    zones: [
      { id: 'in', link: 'a', role: 'in' },
      { id: 'out', link: 'c', role: 'out' },
      { id: 'out_side', link: 'side', role: 'out' },
    ],
  });

  function run(boxCompliance: number) {
    const sim = makeSim(
      {
        version: 1, id: 'box', name: 'box', network: { kind: 'custom', id: 'box' },
        od: [{ origin: 'in', destination: 'out', rateVph: 1200 }], composition: { car: 1 }, mode: 'lane',
        durationS: 3600, warmupS: 0, seed: 5, boxCompliance,
      },
      CLASSES,
      net,
    );
    sim.addVehicle({ classId: 'truck', link: 'b', s: 30, v: 0, y: 1.75 });
    sim.advance(3000); // 600 s
    const vs = sim.vehicles();
    const onB = vs.filter((v) => v.link === 'b');
    const space = Math.min(...onB.map((v) => v.s - v.length));
    return { onM: vs.filter((v) => v.link === 'm').length, waitingOnA: vs.filter((v) => v.link === 'a' && v.v < 0.1).length, space };
  }

  it('boxCompliance = 1: b is full, vehicles wait on a, nobody stands inside the box', () => {
    const r = run(1);
    expect(r.space).toBeLessThan(4.5 + 2); // premise: no room on b for another car
    expect(r.waitingOnA).toBeGreaterThan(0);
    expect(r.onM).toBe(0);
  });

  it('boxCompliance = 0: vehicles enter the box anyway and queue inside it', () => {
    const r = run(0);
    expect(r.space).toBeLessThan(4.5 + 2);
    expect(r.onM).toBeGreaterThan(0);
  });
});
