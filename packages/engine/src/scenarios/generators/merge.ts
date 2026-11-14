import { dcos, dsin, DPI } from '../../core/dmath.ts';
import type { Network } from '../../schema/network.ts';
import type { MergeParams } from '../../schema/scenario.ts';

/**
 * On-ramp merge from the kerb side (docs/MODEL.md §3.6). Kerb of the main road at world
 * y = 0; the acceleration lane adds the ramp lane on the kerb side, and the band rule (§2.2)
 * makes ramp vehicles move across into the main band before the end of `accel`.
 */
export function merge(p: MergeParams): Network {
  const mW = p.mainWidthM;
  const rW = p.rampWidthM;
  const x1 = p.mainLengthM / 2;
  const x2 = x1 + p.taperM;
  const x3 = x2 + p.mainLengthM / 2;
  const a = (p.angleDeg * DPI) / 180;
  const accelY = (rW - mW) / 2;
  const rampEnd: [number, number] = [x1, rW / 2];
  const rampStart: [number, number] = [x1 - p.rampLengthM * dcos(a), rW / 2 + p.rampLengthM * dsin(a)];
  const sl = p.speedLimitMps;
  return {
    version: 1,
    id: 'merge',
    name: 'On-ramp merge',
    nodes: [
      { id: 'n0', x: 0, y: -mW / 2, kind: 'boundary', layer: 0 },
      { id: 'r0', x: rampStart[0], y: rampStart[1], kind: 'boundary', layer: 0 },
      { id: 'n1', x: x1, y: 0, kind: 'merge', layer: 0 },
      { id: 'n2', x: x2, y: -mW / 2, kind: 'plain', layer: 0 },
      { id: 'n3', x: x3, y: -mW / 2, kind: 'boundary', layer: 0 },
    ],
    links: [
      { id: 'main_up', from: 'n0', to: 'n1', polyline: [[0, -mW / 2], [x1, -mW / 2]], widthM: mW, lanes: p.mainLanes, speedLimitMps: sl, layer: 0, zFromM: 0, zToM: 0 },
      { id: 'ramp', from: 'r0', to: 'n1', polyline: [rampStart, rampEnd], widthM: rW, lanes: 1, speedLimitMps: sl, layer: 0, zFromM: 0, zToM: 0 },
      { id: 'accel', from: 'n1', to: 'n2', polyline: [[x1, accelY], [x2, accelY]], widthM: mW + rW, lanes: p.mainLanes + 1, speedLimitMps: sl, layer: 0, zFromM: 0, zToM: 0 },
      { id: 'main_down', from: 'n2', to: 'n3', polyline: [[x2, -mW / 2], [x3, -mW / 2]], widthM: mW, lanes: p.mainLanes, speedLimitMps: sl, layer: 0, zFromM: 0, zToM: 0 },
    ],
    movements: [
      { id: 'main_merge', node: 'n1', fromLink: 'main_up', toLink: 'accel', path: [[x1, -mW / 2], [x1, -mW / 2]], widthM: mW, fromLateral: [0, mW], toLateral: [rW, rW + mW], control: 'free' },
      { id: 'ramp_merge', node: 'n1', fromLink: 'ramp', toLink: 'accel', path: [rampEnd, rampEnd], widthM: rW, fromLateral: [0, rW], toLateral: [0, rW], control: 'free' },
      { id: 'accel_end', node: 'n2', fromLink: 'accel', toLink: 'main_down', path: [[x2, -mW / 2], [x2, -mW / 2]], widthM: mW, fromLateral: [rW, rW + mW], toLateral: [0, mW], control: 'free' },
    ],
    signals: [],
    zones: [
      { id: 'main_in', link: 'main_up', role: 'in' },
      { id: 'ramp_in', link: 'ramp', role: 'in' },
      { id: 'main_out', link: 'main_down', role: 'out' },
    ],
  };
}
