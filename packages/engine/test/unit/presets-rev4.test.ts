/**
 * Revision 4 (docs/MODEL.md §5.2 "Time step", §6.3 item 7): dtS ∈ {0.1, 0.2, 0.25} (default
 * 0.2) and the preset catalogue (names, one-line descriptions, ring-busy removed).
 */
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/index.ts';
import { Scenario } from '../../src/schema/index.ts';

const base = {
  version: 1, id: 's', name: 's', composition: { car: 1 }, durationS: 600, seed: 1,
  network: { kind: 'generator', params: { generator: 'ring', circumferenceM: 1000, widthM: 3.5 } },
};

describe('time step (§5.2)', () => {
  it('accepts 0.1, 0.2, 0.25; rejects 0.5 and 0.05; defaults to 0.2', () => {
    for (const dtS of [0.1, 0.2, 0.25]) expect(Scenario.safeParse({ ...base, dtS }).success, String(dtS)).toBe(true);
    for (const dtS of [0.5, 0.05, 0.3]) expect(Scenario.safeParse({ ...base, dtS }).success, String(dtS)).toBe(false);
    expect(Scenario.parse(base).dtS).toBe(0.2);
  });
});

describe('presets (§6.3 item 7)', () => {
  it('ring-busy is removed; names of ring-demo and corridor-lanedrop', () => {
    expect(PRESETS).not.toHaveProperty('ring-busy');
    expect(PRESETS['ring-demo']!.name).toBe('Ring road (car-following check)');
    expect(PRESETS['corridor-lanedrop']!.name).toBe('Road narrowing');
    expect(PRESETS['corridor-lanedrop']!.description ?? '').toMatch(/pre-?sort/i);
  });

  it('every preset has a non-empty one-line description and parses', () => {
    for (const [id, p] of Object.entries(PRESETS)) {
      const d = p.description ?? '';
      expect(d.trim().length, id).toBeGreaterThan(0);
      expect(d.includes('\n'), id).toBe(false);
      expect(Scenario.safeParse(p).success, id).toBe(true);
    }
  });
});
