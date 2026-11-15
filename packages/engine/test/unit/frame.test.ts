/**
 * §6.1 frame record (revision 3): FRAME_STRIDE = 11 with F_SPEED, F_SPEED_RATIO, F_Z, F_SEG.
 * Assumption (flagged): writeFrame writes the records in the order of sim.vehicles() (by id).
 * Frames are Float32: a stored value differs from the double by ≤ 2^-24 relative, so values are
 * compared within 1e-6·max(1, |x|).
 */
import { describe, expect, it } from 'vitest';
import { FRAME_STRIDE, F_LENGTH, F_SEG, F_SPEED, F_SPEED_RATIO, F_Z } from '../../src/protocol.ts';
import { PRESETS, defaultClasses } from '../../src/index.ts';
import type { ScenarioInput } from '../../src/schema/index.ts';
import { makeSim, type M2Sim } from '../helpers/m2.ts';
import { plen } from '../helpers/m3.ts';

const f32 = (x: number) => 1e-6 * Math.max(1, Math.abs(x));
const frame = (sim: M2Sim) => {
  const out = new Float32Array(FRAME_STRIDE * Math.max(1, sim.vehicleCount()));
  const n = (sim as unknown as { writeFrame(o: Float32Array): number }).writeFrame(out);
  return { out, n };
};

describe('§6.1 frame record', () => {
  it('stride 11 and field indices', () => {
    expect(FRAME_STRIDE).toBe(11);
    expect([F_SPEED, F_SPEED_RATIO, F_Z, F_SEG]).toEqual([7, 8, 9, 10]);
    expect(F_LENGTH).toBe(4);
  });

  it('F_SPEED, F_SPEED_RATIO, F_SEG and F_Z on the flyover preset (ramps, deck, movements, ground)', () => {
    const sc: ScenarioInput = { ...PRESETS['junction4-flyover']!, durationS: 900 };
    const sim = makeSim(sc, defaultClasses());
    const net = sim.network;
    const links = new Map(net.links.map((l, i) => [l.id, { l, i, len: plen(l.polyline) }]));
    const movs = new Map(net.movements.map((m, i) => [m.id, { m, i, len: plen(m.path) }]));
    const v0 = () => new Map(sim.generatedLog().map((r) => [r.id, r.v0]));
    let onRamp = 0;
    let onMovement = 0;
    let onGround = 0;
    for (let k = 1; k <= 3000; k++) {
      sim.advance(1);
      if (k % 50 !== 0) continue;
      const vs = sim.vehicles();
      const { out, n } = frame(sim);
      expect(n).toBe(vs.length);
      const v0s = v0();
      vs.forEach((v, i) => {
        const r = out.subarray(i * FRAME_STRIDE, (i + 1) * FRAME_STRIDE);
        expect(Math.abs(r[F_SPEED]! - v.v)).toBeLessThanOrEqual(f32(v.v));
        const L = links.get(v.link);
        const M = movs.get(v.link);
        const limit = L ? L.l.speedLimitMps : Math.min(links.get(M!.m.fromLink)!.l.speedLimitMps, links.get(M!.m.toLink)!.l.speedLimitMps);
        const ratio = Math.min(1, Math.max(0, v.v / Math.min(v0s.get(v.id)!, limit)));
        expect(Math.abs(r[F_SPEED_RATIO]! - ratio)).toBeLessThanOrEqual(f32(ratio));
        expect(r[F_SEG]).toBe(L ? L.i : net.links.length + M!.i);
        // z at the centre point s − length/2 (only when the centre is on the same segment)
        const c = v.s - v.length / 2;
        if (c < 0) return;
        let z: number;
        if (L) {
          z = L.l.zFromM + ((L.l.zToM - L.l.zFromM) * c) / L.len;
          if (L.l.zFromM === 0 && L.l.zToM === 0) onGround++;
          else if (L.l.zFromM !== L.l.zToM) onRamp++;
        } else {
          const zA = links.get(M!.m.fromLink)!.l.zToM;
          const zB = links.get(M!.m.toLink)!.l.zFromM;
          z = zA + ((zB - zA) * c) / M!.len;
          onMovement++;
        }
        expect(Math.abs(r[F_Z]! - z), `${v.link} s=${v.s}`).toBeLessThanOrEqual(f32(z));
        if (L && L.l.zFromM === 0 && L.l.zToM === 0) expect(r[F_Z]).toBe(0);
      });
    }
    // premises: the run exercised ramps (sloped links), movements and ground links
    expect(onRamp).toBeGreaterThan(0);
    expect(onMovement).toBeGreaterThan(0);
    expect(onGround).toBeGreaterThan(0);
  });

  it('writeFrame is rendering only: state hash and counters are identical with and without it', () => {
    const sc: ScenarioInput = { ...PRESETS['junction4-flyover']!, durationS: 900 };
    const a = makeSim(sc, defaultClasses());
    const b = makeSim(sc, defaultClasses());
    for (let k = 1; k <= 1500; k++) {
      a.advance(1);
      b.advance(1);
      frame(a);
      if (k % 100 === 0) {
        expect(a.stateHash()).toBe(b.stateHash());
        expect(a.counters()).toEqual(b.counters());
      }
    }
  });
});
