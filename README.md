# Weave: agent-based simulation of mixed traffic on road networks

*Submission for the Full Stack AI Pre-doctoral position, QUEST Lab, Department of Computational
and Data Sciences, IISc Bangalore*

**Assignment:** build and run an agent-based model of traffic on a road network with junctions,
flyovers and roads of different widths and capacities. The end goal is a deployed application where
users can set up scenarios and see their results, built end to end from data to the deployed
application.

- **Live app:** <https://weave-simulator.vercel.app>
- **Repository:** <https://github.com/vedantd03/weave>

Weave simulates mixed, non-lane-disciplined traffic.
- **Calibration:** vehicle classes come from the Chennai trajectory data (Kanagaraj et al., 2015).
- **Runtime:** the engine is deterministic TypeScript running in Web Workers in the browser, with
  a React interface.
- **Hosting:** a static site with no server, account or database.

## What the application does
- **Scenarios:** six presets, each with a one-line description in the app.
  - **Ring road (car-following check)**
  - **Road narrowing:** vehicles enter pre-sorted into the continuing lanes, so merging at the
    drop is not simulated.
  - **4-arm signalised junction**
  - **4-arm junction with flyover**
  - **On-ramp merge**
  - **Silk Board, Bengaluru:** imported from OpenStreetMap with its flyovers and the
    double-decker; 117 links and 154 movements.
- **Editing without drawing geometry:**
  - **Network:** arm count, angles and widths; flyover on or off, with deck, ramp and landing
    widths; road width changes and lane drops.
  - **Demand:** the origin–destination table and the vehicle mix.
  - **Signals:** phase greens, amber, all-red and offset.
  - **Behaviour:** strips (mixed traffic) or lanes (theory check), and box compliance.
  - **Run settings:** duration, warm-up, time step (0.1, 0.2 or 0.25 s) and seed.
- **Live view:**
  - **On open:** the app opens on the 4-arm junction with flyover, paused at t = 0, and Play
    starts it.
  - **Map:** vehicles are coloured by class or by speed, with a legend.
  - **Display:** signal heads, flyovers drawn above the junction, live charts, the
    collision-guard rate and gridlock notices.
  - **Inspection:** hovering over or tapping a vehicle, road or traffic light shows its
    details.
- **Optional 3D view:**
  - **Roads:** roads follow their elevation, and decks and ramps stand on pillars.
  - **Traffic lights:** signalised stop lines have lights on poles, in the same states as the
    2D map.
  - **Controls:** orbit, pan and zoom by mouse or touch.
  - **Loading:** three.js loads only when 3D is opened.
- **Run export:** a paused run exports as one JSON file (schema in
  `docs/schema/run-export.schema.json`), plus trips and the 1-minute series as CSV.
  - **Contents:** the scenario, seed, final state hash, metrics, per-link statistics, trip
    records (including the delay so far of unfinished trips) and diagnostics.
  - **Replay:** the Node CLI replays an export to the same state hash.
- **Experiments**, on any scenario, in parallel workers:
  - **Replicate:** the scenario over N seeds, with means and 95% Student-t intervals.
  - **Compare:** two or more named scenarios, such as a baseline and variants edited in the form.
    - **One-click variants:** the flyover variants.
    - **Differences:** listed in plain words, e.g. "Demand 3,000 → 3,600 veh/h; Arm 2 green 25 →
      35 s".
    - **Pairing:** seeds are paired only when zones and OD pairs match. Otherwise the app uses
      Welch intervals and states the reason.
  - **Sweep:** one applicable parameter over up to 10 points, with the same seeds at every point.
    The parameters are demand scale, motorcycle share, a phase's green, a width, ramp or
    acceleration-lane length, flyover on/off, and strips vs lanes.
- **Experiment results:**
  - **While running:** a time estimate before the run, then progress, ETA and Cancel.
  - **Summary:** a plain-English summary, with means and 95% intervals and paired or Welch
    differences.
  - **Charts:** interval bars for Compare. Sweep shows a line with a 95% band, with problem points
    marked.
  - **Breakdowns:** by approach, by junction movement and, for networks with up to 40 OD pairs,
    by OD pair.
  - **Stability flags:** shown in every table, summary and CSV: gridlocked, entry queue still
    growing, and vehicles inside the network still growing.
- **History and sharing:**
  - **History:** experiments are saved in the browser; they can be reopened, compared two at a
    time and deleted.
  - **Export and import:** experiments export as JSON or CSV. Importing an experiment reruns it;
    importing a run export replays it and checks its state hash.
  - **Links:** the URL carries the scenario, so a link restores the setup.

**Example result** (4-arm junction with flyover, 10 paired seeds, 1 h each):
- **Flyover:** it reduces mean delay by **15.9 s** (95% CI 13.9 to 17.8 s), from 55.2 to 39.3 s.
- **Webster retiming:** retiming the at-grade signals reduces it by a further **3.1 s** (95% CI 1.8
  to 4.4 s).
- **Delay definition:** mean delay counts every generated vehicle, including trips still under
  way or waiting to enter at the end of the run.
- **Stability:** no run gridlocked.

## The model
- **Lateral strips:** road width is divided into 0.25 m strips anchored at the kerb. A vehicle
  occupies the strips covered by its width plus a calibrated lateral clearance.
- **Car-following:** IDM, with a synchronous ballistic update at dt = 0.2 s. A vehicle follows the
  nearest **rear end** among the vehicles overlapping its strips.
- **Lateral movement:** generalised MOBIL over strip offsets.
  - **Route bias:** moves are biased towards the vehicle's route.
  - **Safety:** checks cover both the new follower and the mover.
  - **Order:** moves commit in a deterministic order.
  - **Lane mode:** the special case of one strip per lane, which reduces to classic MOBIL.
- **Junctions:**
  - **Signals:** movement-specific, protected or permissive, with amber and all-red.
  - **Yielding:** gap acceptance with critical gap and follow-up headway, which reproduces
    Harders' capacity; an accepted gap is a commitment.
  - **Paths and conflicts:** merging and diverging; conflict areas from intersecting swept paths.
  - **Blocking:** don't-block-the-box and spillback.
  - **Gridlock:** detected per junction.
  - **No teleporting:** vehicles are never removed to clear a jam.
- **Flyovers:** separate layers that meet the ground only through ramps.
- **Deadlocks:** a vehicle stuck for 20 s in front of a lane band it cannot reach takes the branch
  it fits and is rerouted. Trips that end at a different exit are counted as diverted.
- **Randomness:** every draw comes from a per-entity substream, giving common random numbers
  between variants.
  - **Cross-runtime check:** the same seed gives identical state hashes in Node, Chromium and
    WebKit. Firefox was not tested; Playwright's Firefox did not launch on the development
    machine.

Specification: [docs/MODEL.md](docs/MODEL.md). Decisions and their reasons:
[docs/DECISIONS.md](docs/DECISIONS.md). Validation: [docs/VALIDATION.md](docs/VALIDATION.md).

## Validation and limitations
- **Data checks:**
  - **Flow:** counting vehicles across lines gives 6,095 veh/h, against the paper's 6,010 veh/h.
  - **Speed column:** the dataset's speed column is 1.92 times lower than speeds computed from
    positions, so it is not used.
  - **Density:** the paper's density figure is inconsistent with its flow and speeds.
    VALIDATION.md records this.
- **Parameter provenance:** every vehicle parameter is labelled derived, proxy or assumption.
  - **s0:** assumed.
  - **v0:** a proxy, the 85th-percentile speed.
  - **a and b:** depend on the smoothing window.
  - **T:** conditional on s0 and v0.

  VALIDATION.md has the sensitivity tables.
- **Vehicle widths:** measured widths are capped at 2.6 m as a data correction (44 of 95 buses and
  1 of 40 LCVs were wider).
- **Lateral speeds:** taken from deliberate moves of at least 1 m, as the 85th percentile of each
  move's peak lateral speed.

  | Class | Speed (m/s) | Basis |
  |---|---|---|
  | Motorcycle | 0.86 | derived |
  | Car | 0.78 | derived |
  | Auto-rickshaw | 0.63 | derived |
  | Bus | 0.61 | derived, from 18 moves |
  | Truck | 0.61 | assumption: the bus value |
  | LCV | 0.78 | assumption: the car value |
- **Fundamental diagram:** the Chennai data covers the free-flow branch only. It does not
  validate capacity or the effect of road width.
- **Simulated vs observed:** the parameters were not tuned to close the gap.

  | 11.2 m road at about 6,000 veh/h | Speed | Density |
  |---|---|---|
  | Simulated | 47.1 km/h | 129 veh/km |
  | Observed in Chennai | 41.1 km/h | 148 veh/km |
  | Simulated, v0 reduced by 10% | 42.1 km/h | 145 veh/km |

  Reducing v0 by 10% accounts for 84% of the speed gap.
- **On-ramp merge:** the merge section carries up to about 2,850 veh/h.
  - **Preset (2,000 + 500 veh/h):** no gridlock in 10 of 10 seeds.
  - **At 2,400 + 600 veh/h:** one seed in 10 jams; the cause has not been traced.
- **Not modelled:** merging at lane drops.
- **Silk Board:**
  - **Demand:** plausible, not observed. The preset is 60% of an initial 125 veh/h per entry
    lane, giving 1,770 veh/h.
  - **Preset over seeds 42–51:** no locked junction, no growing entry queue and no growing
    network count.
    - **Throughput:** 1,770 ± 37 veh/h.
    - **Mean delay:** 49.3 ± 5.2 s.
    - **Diverted trips:** about 101 per run (6% of trips).
  - **Other seeds:** some are not stable at this demand. In seeds 57 and 58, vehicles inside the
    network keep growing.
  - **Higher demand:** junctions lock from 70% of the initial demand (3 of 10 seeds), and at 100%
    in 10 of 10 seeds.
- **Collision guard:** a kinematic guard caps a vehicle's movement if a leader brakes harder
  than IDM assumes. It fired at these rates, per 1,000 vehicle-km:

  | Scenario | Rate |
  |---|---|
  | Corridors and ring | 0 |
  | On-ramp merge | 3–7 |
  | 4-arm junction | 23 |
  | Flyover junction | 42–52 |
  | Silk Board preset | 65 |
- **Lighthouse:** run on https://weave-simulator.vercel.app with `pnpm lighthouse` (Lighthouse
  12.8.2, default mobile settings). The median of 3 runs is Performance 98, Accessibility 100
  and Best Practices 100.

## Repository
| Path | Contents |
|---|---|
| `packages/engine` | Simulation engine and statistics, pure TypeScript with no DOM or React; zod schemas form the shared contract; `bin/weave.mjs` is the Node CLI. |
| `apps/web` | Vite + React + Tailwind app: Canvas2D renderer, lazy three.js 3D view, simulation worker, experiment worker pool, uPlot charts. |
| `data-pipeline` | Python 3.12 (uv): Chennai calibration and the OSM → SUMO netconvert → network JSON conversion. |
| `data` | Raw inputs. The Chennai `.xlsx` files are not committed; `osm/silkboard.osm` is. |
| `docs` | Model specification, decisions, testing, validation, emitted JSON Schemas and shared test fixtures. |

## Running it locally
```bash
pnpm install
pnpm --filter @weave/web dev           # app at http://localhost:5173
pnpm typecheck && pnpm test            # engine: theory, unit and property tests
pnpm --filter @weave/web e2e           # end-to-end tests on the production build
pnpm --filter @weave/web e2e:live      # the same tests against the deployed site
pnpm lighthouse                        # Lighthouse, 3 runs, default mobile settings
node packages/engine/bin/weave.mjs --scenario weave-run-….json   # replay an exported run
cd data-pipeline && uv sync && uv run pytest
uv run python build.py                 # rebuild network and calibration (needs data/chennai/*.xlsx)
pnpm --filter @weave/engine sync-classes
```

## How it was built and tested
- **Specification first:** each milestone started with the specification in `docs/MODEL.md`.
- **Separate test author:** tests were written by a separate test-author agent from the
  specification, and expected values come from theory computed inside the tests or from cited
  papers.
  - **Test-first record:** most tests were committed failing (`test:` commits) before the code
    they test.
  - **Exceptions:** some tests passed on arrival, because the code was written alongside them.
    For the experiments revision, the test author also read the implementation. Each exception
    is stated in its commit message.
- **Theory checks include:** IDM equilibrium and string stability, the fundamental diagram,
  Harders' gap-acceptance capacity, Webster's effective green, the LWR shockwave speed, Little's
  law, conservation at every step, a no-collision property, t-interval coverage, Welch-interval
  coverage and common random numbers.
- **Test counts:**
  - **Engine:** 344 tests.
  - **Data pipeline:** 106 tests.
  - **End-to-end:** 115 tests on desktop and mobile, plus the hash checks in WebKit.
  - **Browser vs Node:** some end-to-end tests check identical state hashes. One exports a run
    from the browser and replays it with the Node CLI.
- **Disagreements:** when a test disagreed with the model, the specification was changed and the
  reason recorded, and the test was not weakened. See `docs/TESTING.md` and ADR-014 to ADR-025.

## Data sources and citations
- **Trajectories:** Kanagaraj V., Asaithambi G., Toledo T., Lee T.-C. (2015). *Trajectory data
  and flow characteristics of mixed traffic.* Transportation Research Record 2491, 1–11.
  - **Distribution:** the data is distributed by T. Toledo (Technion):
    https://toledo.net.technion.ac.il/?p=387.
  - **Not redistributed:** the raw files are not included here.
- **Road network:** © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
  One Overpass extract; see `data/osm/README.md`.
- **Network conversion:** Eclipse SUMO `netconvert` (EPL 2.0), used offline only. Nothing from
  SUMO ships in the app.
- **Models:**
  - **IDM:** Treiber, Hennecke & Helbing (2000).
  - **MOBIL:** Kesting, Treiber & Helbing (2007).
  - **Ballistic update:** Treiber & Kanagaraj (2015).
  - **Gap-acceptance capacity:** Harders (1968) / HCM 2016.
  - **Signal timing:** Webster (1958).
