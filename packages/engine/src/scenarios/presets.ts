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
};
