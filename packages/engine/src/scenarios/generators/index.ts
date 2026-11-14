import { dcos, dsin, DPI } from '../../core/dmath.ts';
import { Network } from '../../schema/network.ts';
import type { GeneratorParams, RingParams } from '../../schema/scenario.ts';

/**
 * Parametric network generators (ADR-012). Geometry uses dsin/dcos so generated coordinates —
 * and therefore link lengths and the whole simulation — are bit-identical across JS engines.
 */
export function generateNetwork(params: GeneratorParams): Network {
  switch (params.generator) {
    case 'ring':
      return ring(params);
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
