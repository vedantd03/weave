import { SILKBOARD_OD } from './silkboard-od.ts';
import type { ScenarioInput } from '../schema/scenario.ts';

const CHENNAI_MIX = { motorcycle: 0.564, car: 0.266, auto: 0.122, bus: 0.032, truck: 0.003, lcv: 0.013 };

const ARM = (angleDeg: number) => ({ angleDeg, inWidthM: 7, outWidthM: 7, inLanes: 2, outLanes: 2, lengthM: 250 });
const JUNCTION4 = { generator: 'junction' as const, arms: [ARM(0), ARM(90), ARM(180), ARM(270)], control: 'signal' as const, speedLimitMps: 13.9 };

/** Through 450, left 150, right 150 veh/h from every arm (arms 0/2 and 1/3 are opposite). */
const JUNCTION_OD = [0, 1, 2, 3].flatMap((i) =>
  [0, 1, 2, 3]
    .filter((k) => k !== i)
    .map((k) => ({ origin: `arm${i}_in`, destination: `arm${k}_out`, rateVph: (k - i + 4) % 4 === 2 ? 450 : 150 })),
);

/** Built-in scenarios shown in the UI and reproduced by tests (browser vs Node). */
export const PRESETS: Record<string, ScenarioInput> = {
  'ring-demo': {
    version: 1,
    id: 'ring-demo',
    name: 'Ring road (demo)',
    network: {
      kind: 'generator',
      params: { generator: 'ring', circumferenceM: 800, widthM: 7, lanes: 2, speedLimitMps: 16.7 },
    },
    composition: { motorcycle: 0.5, car: 0.3, auto: 0.1, bus: 0.04, truck: 0.02, lcv: 0.04 },
    initialDensityPerKm: 70,
    initialJitterM: 2,
    durationS: 3600,
    warmupS: 0,
    seed: 42,
  },
  'ring-busy': {
    version: 1,
    id: 'ring-busy',
    name: 'Busy ring, 3 lanes (540 vehicles)',
    network: {
      kind: 'generator',
      params: { generator: 'ring', circumferenceM: 2000, widthM: 10.5, lanes: 3, speedLimitMps: 16.7 },
    },
    composition: { motorcycle: 0.5, car: 0.3, auto: 0.1, bus: 0.04, truck: 0.02, lcv: 0.04 },
    initialDensityPerKm: 270,
    initialJitterM: 0.5,
    durationS: 3600,
    warmupS: 0,
    seed: 42,
  },
  'corridor-lanedrop': {
    version: 1,
    id: 'corridor-lanedrop',
    // Vehicles enter already sorted into the continuing lanes (band rule, MODEL.md §2.3):
    // merging at the drop is not modelled, so this shows a narrowing, not a merge.
    name: 'Corridor narrowing (vehicles pre-sorted)',
    network: {
      kind: 'generator',
      params: {
        generator: 'corridor',
        lengthM: 1000,
        widthM: 10.5,
        lanes: 3,
        speedLimitMps: 16.7,
        change: { kind: 'laneDrop', atM: 600, dropLanes: 1, taperM: 50 },
      },
    },
    od: [{ origin: 'in', destination: 'out', rateVph: 3600 }],
    // Chennai class shares (classes.json, derived from vehicle counts).
    composition: { motorcycle: 0.564, car: 0.266, auto: 0.122, bus: 0.032, truck: 0.003, lcv: 0.013 },
    mode: 'strip',
    durationS: 3600,
    warmupS: 300,
    seed: 42,
  },
  'junction4-signal': {
    version: 1,
    id: 'junction4-signal',
    name: '4-arm signalised junction',
    network: { kind: 'generator', params: JUNCTION4 },
    od: JUNCTION_OD,
    composition: CHENNAI_MIX,
    mode: 'strip',
    durationS: 3600,
    warmupS: 300,
    seed: 42,
  },
  'junction4-flyover': {
    version: 1,
    id: 'junction4-flyover',
    name: '4-arm junction with flyover',
    network: {
      kind: 'generator',
      params: {
        ...JUNCTION4,
        flyover: { enabled: true, armA: 0, armB: 2, deckWidthM: 7, rampWidthM: 3.5, landingWidthM: 3.5, rampLengthM: 150, heightM: 6.5 },
      },
    },
    od: JUNCTION_OD,
    composition: CHENNAI_MIX,
    mode: 'strip',
    durationS: 3600,
    warmupS: 300,
    seed: 42,
  },
  'merge-onramp': {
    version: 1,
    id: 'merge-onramp',
    name: 'On-ramp merge',
    network: {
      kind: 'generator',
      params: { generator: 'merge', mainWidthM: 7, mainLanes: 2, rampWidthM: 3.5, taperM: 300, mainLengthM: 800, rampLengthM: 250, angleDeg: 15, speedLimitMps: 16.7 },
    },
    // Merging capacity is limited by the calibrated lateral speeds (VALIDATION.md §8).
    od: [
      { origin: 'main_in', destination: 'main_out', rateVph: 2000 },
      { origin: 'ramp_in', destination: 'main_out', rateVph: 500 },
    ],
    composition: CHENNAI_MIX,
    mode: 'strip',
    durationS: 3600,
    warmupS: 300,
    seed: 42,
  },
  silkboard: {
    version: 1,
    id: 'silkboard',
    name: 'Silk Board, Bengaluru',
    network: { kind: 'file', id: 'silkboard' },
    od: SILKBOARD_OD,
    composition: CHENNAI_MIX,
    mode: 'strip',
    durationS: 3600,
    warmupS: 300,
    seed: 42,
  },
};

