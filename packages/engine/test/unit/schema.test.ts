import { describe, expect, it } from 'vitest';
import { ClassSet, Network, Scenario, ToWorker, FRAME_STRIDE, F_LENGTH } from '../../src/index.ts';

const p = (value: number) => ({ value, provenance: 'assumption' as const, note: 'test' });

const twoLinkNetwork = {
  version: 1 as const,
  id: 't',
  name: 'two links',
  nodes: [
    { id: 'a', x: 0, y: 0, kind: 'boundary' as const },
    { id: 'b', x: 100, y: 0, kind: 'priority' as const },
    { id: 'c', x: 200, y: 0, kind: 'boundary' as const },
  ],
  links: [
    { id: 'l1', from: 'a', to: 'b', polyline: [[0, 0], [100, 0]] as [number, number][], widthM: 7, lanes: 2, speedLimitMps: 14 },
    { id: 'l2', from: 'b', to: 'c', polyline: [[100, 0], [200, 0]] as [number, number][], widthM: 7, lanes: 2, speedLimitMps: 14 },
  ],
  movements: [
    {
      id: 'm1', node: 'b', fromLink: 'l1', toLink: 'l2',
      path: [[100, 0], [100.1, 0]] as [number, number][], widthM: 7,
      fromLateral: [0, 7] as [number, number], toLateral: [0, 7] as [number, number], control: 'free' as const,
    },
  ],
  zones: [
    { id: 'in', link: 'l1', role: 'in' as const },
    { id: 'out', link: 'l2', role: 'out' as const },
  ],
};

describe('contract: network schema', () => {
  it('parses a valid network and round-trips through JSON unchanged', () => {
    const parsed = Network.parse(twoLinkNetwork);
    const again = Network.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
    expect(parsed.links[0]!.layer).toBe(0);
  });

  it('rejects dangling references and duplicate ids', () => {
    const bad = JSON.parse(JSON.stringify(twoLinkNetwork)) as typeof twoLinkNetwork;
    bad.links[1]!.to = 'nowhere';
    bad.zones.push({ id: 'in', link: 'l1', role: 'in' });
    const r = Network.safeParse(bad);
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('unknown to-node'))).toBe(true);
    expect(messages.some((m) => m.includes('duplicate zone'))).toBe(true);
  });

  it('rejects a movement whose fromLink does not end at its node', () => {
    const bad = JSON.parse(JSON.stringify(twoLinkNetwork)) as typeof twoLinkNetwork;
    bad.movements[0]!.fromLink = 'l2';
    expect(Network.safeParse(bad).success).toBe(false);
  });
});

describe('contract: classes and scenario', () => {
  const cls = {
    id: 'car' as const, label: 'Car',
    lengthM: { kind: 'quantiles' as const, q: [3.6, 4.2, 4.8], provenance: 'derived' as const, note: '' },
    widthM: { kind: 'fixed' as const, value: 1.7, provenance: 'derived' as const, note: '' },
    idm: { v0: p(14), T: p(1.2), s0: p(2), a: p(1.5), b: p(2) },
    clearance: { c0: p(0.2), c1: p(0) },
    gap: { criticalS: p(4), followUpS: p(2.5) },
    lateral: { maxSpeedMps: p(0.8), politeness: p(0.2), thresholdMps2: p(0.1) },
    share: p(0.3),
  };

  it('accepts a class set and applies the default spread of 0', () => {
    const set = ClassSet.parse({ version: 1, source: 'test', classes: [cls] });
    expect(set.classes[0]!.idm.v0.spread).toBe(0);
  });

  it('rejects decreasing quantiles', () => {
    const bad = { ...cls, lengthM: { ...cls.lengthM, q: [4, 3] } };
    expect(ClassSet.safeParse({ version: 1, source: 't', classes: [bad] }).success).toBe(false);
  });

  it('validates an init message at the worker boundary', () => {
    const scenario = Scenario.parse({
      version: 1, id: 's', name: 's',
      network: { kind: 'generator', params: { generator: 'ring', circumferenceM: 1000, widthM: 3.5 } },
      composition: { car: 1 }, durationS: 600, seed: 42,
    });
    expect(scenario.dtS).toBe(0.2);
    expect(scenario.mode).toBe('strip');
    const msg = ToWorker.parse({ type: 'init', scenario, classes: { version: 1, source: 't', classes: [cls] } });
    expect(msg.type).toBe('init');
    expect(ToWorker.safeParse({ type: 'step', steps: 0 }).success).toBe(false);
  });

  it('rejects an invalid flyover arm selection', () => {
    const arm = { angleDeg: 0, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2 };
    const r = Scenario.safeParse({
      version: 1, id: 's', name: 's', composition: { car: 1 }, durationS: 600, seed: 1,
      network: {
        kind: 'generator',
        params: {
          generator: 'junction', control: 'signal',
          arms: [arm, { ...arm, angleDeg: 90 }, { ...arm, angleDeg: 180 }],
          flyover: { enabled: true, armA: 0, armB: 0, deckWidthM: 7, rampWidthM: 4, landingWidthM: 7, rampLengthM: 120 },
        },
      },
    });
    expect(r.success).toBe(false);
  });

  it('frames carry vehicle length in every record', () => {
    expect(FRAME_STRIDE).toBe(11); // §6.1 (revision 3): 7 original fields + speed, speed ratio, z, segment
    expect(F_LENGTH).toBeLessThan(FRAME_STRIDE);
  });
});
