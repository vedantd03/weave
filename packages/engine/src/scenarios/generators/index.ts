import { dcos, dsin, DPI } from '../../core/dmath.ts';
import { Network } from '../../schema/network.ts';
import type { CorridorParams, GeneratorParams, RingParams } from '../../schema/scenario.ts';

/**
 * Parametric network generators (ADR-012). Geometry uses dsin/dcos so generated coordinates —
 * and therefore link lengths and the whole simulation — are bit-identical across JS engines.
 */
export function generateNetwork(params: GeneratorParams): Network {
  switch (params.generator) {
    case 'ring':
      return ring(params);
    case 'corridor':
      return corridor(params);
    default:
      throw new Error(`generator '${params.generator}' is not available yet`);
  }
}

/** One link n0 → n0 whose 360-gon polyline has perimeter = circumferenceM (MODEL.md §1.7). */
function ring(p: RingParams): Network {
  const N = 360;
  const R = p.circumferenceM / (2 * N * dsin(DPI / N));
  const pts: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const th = (2 * DPI * k) / N;
    pts.push([R * dcos(th), R * dsin(th)]);
  }
  pts.push([pts[0]![0], pts[0]![1]]);
  const p0 = pts[0]!;
  return Network.parse({
    version: 1,
    id: 'ring',
    name: `Ring road ${p.circumferenceM} m`,
    nodes: [{ id: 'n0', x: p0[0], y: p0[1], kind: 'plain' }],
    links: [
      {
        id: 'ring',
        from: 'n0',
        to: 'n0',
        polyline: pts,
        widthM: p.widthM,
        lanes: p.lanes,
        speedLimitMps: p.speedLimitMps,
      },
    ],
    movements: [
      {
        id: 'ring-loop',
        node: 'n0',
        fromLink: 'ring',
        toLink: 'ring',
        path: [p0, [p0[0], p0[1]]],
        widthM: p.widthM,
        fromLateral: [0, p.widthM],
        toLateral: [0, p.widthM],
        control: 'free',
      },
    ],
  });
}

/**
 * Corridor along +x with the kerb (left edge) straight at world y = 0 (MODEL.md §2.6).
 * A width change or lane drop splits it into up → taper (movement) → down.
 */
function corridor(p: CorridorParams): Network {
  const W = p.widthM;
  const L = p.lengthM;
  const base = { version: 1 as const, id: 'corridor', name: `Corridor ${L} m` };
  if (p.change.kind === 'none') {
    return Network.parse({
      ...base,
      nodes: [
        { id: 'n0', x: 0, y: -W / 2, kind: 'boundary' },
        { id: 'n1', x: L, y: -W / 2, kind: 'boundary' },
      ],
      links: [
        { id: 'main', from: 'n0', to: 'n1', polyline: [[0, -W / 2], [L, -W / 2]], widthM: W, lanes: p.lanes, speedLimitMps: p.speedLimitMps },
      ],
      zones: [
        { id: 'in', link: 'main', role: 'in' },
        { id: 'out', link: 'main', role: 'out' },
      ],
    });
  }
  const c = p.change;
  const lanes2 = c.kind === 'laneDrop' ? p.lanes - c.dropLanes : c.toLanes;
  const W2 = c.kind === 'laneDrop' ? (W * lanes2) / p.lanes : c.toWidthM;
  const x1 = c.atM;
  const x2 = c.atM + c.taperM;
  const band: [number, number] = [0, Math.min(W, W2)];
  return Network.parse({
    ...base,
    nodes: [
      { id: 'n0', x: 0, y: -W / 2, kind: 'boundary' },
      { id: 'n1', x: x1, y: -W / 2, kind: 'plain' },
      { id: 'n2', x: L, y: -W2 / 2, kind: 'boundary' },
    ],
    links: [
      { id: 'up', from: 'n0', to: 'n1', polyline: [[0, -W / 2], [x1, -W / 2]], widthM: W, lanes: p.lanes, speedLimitMps: p.speedLimitMps },
      { id: 'down', from: 'n1', to: 'n2', polyline: [[x2, -W2 / 2], [L, -W2 / 2]], widthM: W2, lanes: lanes2, speedLimitMps: p.speedLimitMps },
    ],
    movements: [
      {
        id: 'taper',
        node: 'n1',
        fromLink: 'up',
        toLink: 'down',
        path: [[x1, -W2 / 2], [x2, -W2 / 2]],
        widthM: W2,
        fromLateral: band,
        toLateral: band,
        control: 'free',
      },
    ],
    zones: [
      { id: 'in', link: 'up', role: 'in' },
      { id: 'out', link: 'down', role: 'out' },
    ],
  });
}
