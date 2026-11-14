import type { OdEntry } from '../schema/scenario.ts';

/**
 * Default Silk Board demand: PLAUSIBLE, NOT OBSERVED (no public OD exists). Each entry zone
 * generates 125 veh/h per lane, split over the reachable exit zones in proportion to their
 * lanes (no U-turn onto the same road), about 2,900 veh/h in total. At higher demand junctions
 * lock (VALIDATION.md). Editable in the OD editor.
 */
export const SILKBOARD_OD: OdEntry[] = [
  {
    origin: "in-e-outer-ring-road",
    destination: "out-e-tertiary",
    rateVph: 50
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 50
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-nw-hosur-road",
    rateVph: 80
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-nw-tertiary",
    rateVph: 30
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-se-hosur-road",
    rateVph: 80
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-se-tertiary",
    rateVph: 50
  },
  {
    origin: "in-e-outer-ring-road",
    destination: "out-w-tertiary",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-e-outer-ring-road",
    rateVph: 50
  },
  {
    origin: "in-e-tertiary",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-nw-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-e-tertiary",
    destination: "out-se-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-primary",
    rateVph: 30
  },
  {
    origin: "in-e-tertiary",
    destination: "out-w-primary-link",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-e-outer-ring-road",
    rateVph: 50
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-e-tertiary",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-nw-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-se-hosur-road",
    rateVph: 50
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-se-tertiary",
    rateVph: 30
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-w-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-n-madiwala-sarjapura-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-e-outer-ring-road",
    rateVph: 60
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-e-tertiary",
    rateVph: 40
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 40
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-se-tertiary",
    rateVph: 40
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-w-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-nw-hosur-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-nw-tertiary",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 50
  },
  {
    origin: "in-nw-tertiary",
    destination: "out-nw-hosur-road",
    rateVph: 80
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-e-outer-ring-road",
    rateVph: 40
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-e-tertiary",
    rateVph: 30
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-nw-hosur-road",
    rateVph: 40
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-nw-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-se-hosur-road",
    rateVph: 40
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-se-tertiary",
    rateVph: 30
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-w-outer-ring-road",
    rateVph: 20
  },
  {
    origin: "in-se-15th-cross-road",
    destination: "out-w-tertiary",
    rateVph: 20
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-e-outer-ring-road",
    rateVph: 90
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-e-tertiary",
    rateVph: 60
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 60
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-nw-tertiary",
    rateVph: 30
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-se-tertiary",
    rateVph: 60
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-sw-tank-bund-road",
    rateVph: 30
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-w-outer-ring-road",
    rateVph: 30
  },
  {
    origin: "in-se-hosur-road",
    destination: "out-w-tertiary",
    rateVph: 30
  },
  {
    origin: "in-se-service-road",
    destination: "out-e-outer-ring-road",
    rateVph: 40
  },
  {
    origin: "in-se-service-road",
    destination: "out-e-tertiary",
    rateVph: 30
  },
  {
    origin: "in-se-service-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 30
  },
  {
    origin: "in-se-service-road",
    destination: "out-nw-hosur-road",
    rateVph: 40
  },
  {
    origin: "in-se-service-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-se-service-road",
    destination: "out-se-hosur-road",
    rateVph: 40
  },
  {
    origin: "in-se-service-road",
    destination: "out-se-tertiary",
    rateVph: 30
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
    rateVph: 20
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-e-tertiary",
    rateVph: 20
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 20
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-nw-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-nw-tertiary",
    rateVph: 10
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-se-hosur-road",
    rateVph: 20
  },
  {
    origin: "in-sw-tank-bund-road",
    destination: "out-se-tertiary",
    rateVph: 20
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
    rateVph: 50
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-n-madiwala-sarjapura-road",
    rateVph: 50
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-nw-hosur-road",
    rateVph: 80
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-nw-tertiary",
    rateVph: 30
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-se-hosur-road",
    rateVph: 80
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-se-tertiary",
    rateVph: 50
  },
  {
    origin: "in-w-outer-ring-road",
    destination: "out-w-tertiary",
    rateVph: 30
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-e-tertiary",
    rateVph: 70
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-se-hosur-road",
    rateVph: 110
  },
  {
    origin: "in-w-ragigudda-silk-board-integrated-flyover",
    destination: "out-se-tertiary",
    rateVph: 70
  }
];
