import type { OdEntry } from '../schema/scenario.ts';

/**
 * Default Silk Board demand: PLAUSIBLE, NOT OBSERVED (no public OD exists). Each entry zone
 * generates 75 veh/h per lane, split over the reachable exit zones in proportion to their lanes
 * (no U-turn onto the same road), 1790 veh/h in total. This is the highest level (60% of the
 * earlier 2,950 veh/h preset) at which 10 seeds run one hour with no locked junction; at 70% one
 * seed in 10 locks, at 80% two, at 100% eight (VALIDATION.md §9). Editable in the OD editor.
 */
export const SILKBOARD_OD: OdEntry[] = [
  {
    origin: "in-e-outer-ring-road",
    destination: "out-e-tertiary",
    rateVph: 30
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-nw-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-se-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-se-tertiary",
    rateVph: 30
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-e-tertiary",
    destination: "out-e-outer-ring-road",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 20
  },
  {
    origin: "in-e-tertiary",
    destination: "out-nw-hosur-road",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-se-hosur-road",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-primary",
    rateVph: 20
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-primary-link",
    rateVph: 20
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-e-outer-ring-road",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-e-tertiary",
    rateVph: 20
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-nw-hosur-road",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-se-hosur-road",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-se-tertiary",
    rateVph: 20
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-w-tertiary",
    rateVph: 10
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-e-outer-ring-road",
    rateVph: 40
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-e-tertiary",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-se-tertiary",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-w-tertiary",
    rateVph: 10
  },
  {
    origin: "in-nw-tertiary",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-nw-tertiary",
    destination: "out-nw-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-e-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-e-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-nw-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-se-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-se-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-w-tertiary",
    rateVph: 10
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-e-outer-ring-road",
    rateVph: 50
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-e-tertiary",
    rateVph: 40
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 40
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-se-tertiary",
    rateVph: 40
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-sw-tank-bund-road",
    rateVph: 20
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-w-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-e-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-e-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-nw-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-se-service-road",
    destination: "out-se-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-se-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-service-road",
    destination: "out-sw-tank-bund-road",
    rateVph: 10
  },
  {
    origin: "in-se-service-road",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-se-service-road",
    destination: "out-w-tertiary",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-e-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-e-tertiary",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-nw-hosur-road",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-se-hosur-road",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-se-tertiary",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-w-outer-ring-road",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-w-tertiary",
    rateVph: 10
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-e-tertiary",
    rateVph: 30
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-nw-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-se-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-se-tertiary",
    rateVph: 30
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-e-tertiary",
    rateVph: 40
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-se-hosur-road",
    rateVph: 70
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-se-tertiary",
    rateVph: 40
  }
];
