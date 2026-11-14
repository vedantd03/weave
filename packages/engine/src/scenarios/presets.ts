import type { ScenarioInput } from '../schema/scenario.ts';

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
};
