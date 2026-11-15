# Weave

**Agent-based simulation of mixed, non-lane-disciplined traffic** on road networks with
junctions, flyovers and roads of different widths. Vehicles are calibrated on Chennai
trajectory data. Everything runs in your browser: a deterministic TypeScript engine in Web
Workers, a React UI, and a static deployment with no server.

**Live app:** https://weave-simulator.vercel.app

## What you can do
- **Pick a scenario:**
  - **Theory and simple roads:** a ring road (car-following check) and a road narrowing.
  - **Junctions:** a 4-arm signalised junction, with or without a flyover, and an on-ramp
    merge.
  - **A real network:** **Silk Board, Bengaluru**, imported from OpenStreetMap with its
    flyovers and the double-decker.
  - **Descriptions:** each scenario has a one-line description of what it shows.
- **Edit it without drawing geometry:**
  - **Network:** arm count, angles and widths; flyover on or off, with deck, ramp and landing
    widths; corridor width changes and lane drops.
  - **Demand:** the origin–destination table and the vehicle mix.
  - **Signals:** the plan (phase greens, amber, all-red, offset).
  - **Behaviour:** strip mode (mixed traffic) or lane mode (theory check), and box compliance.
  - **Run settings:** duration, warm-up, time step and seed.
- **Watch it live:** the app opens on the 4-arm junction with flyover, paused at t = 0 with
  the network drawn. Press Play to start.
  - **Colour:** colour vehicles by class or by speed (red when stopped, green at free flow),
    with a legend.
  - **Map:** signal heads, flyovers drawn above the box, live charts, the collision-guard rate
    and gridlock notices.
  - **Inspect:** hover over or tap any vehicle or road for its details, in 2D or 3D. 3D picks
    with CPU raycasting and never reads pixels back from the GPU.
- **3D view (optional):** roads follow their real elevation, and decks and ramps stand on
  pillars. Traffic lights on poles at every signalised stop line show the same signal states as
  the 2D map. You can orbit, pan and zoom with a mouse or by touch. three.js loads only when you
  open 3D.
- **Export a run:** pause and download one JSON file (validated against
  `docs/schema/run-export.schema.json`), plus trips and series as CSV.
  - **Contents:** the scenario and seed, the final state hash, metrics, the 1-minute series,
    per-link statistics, trip records (including unfinished trips' delay so far) and
    diagnostics.
  - **Replay:** the Node CLI replays it and checks the hash.
- **Run experiments:** *N* seeds in parallel workers, with means and 95% Student-t intervals.
  You can compare "flyover off", "flyover on with the same timings" and "flyover on, retimed"
  using **paired** intervals over common random numbers, then export to CSV.

**Example result** (4-arm preset, 10 paired seeds, 1 h): the flyover cuts mean delay by
**15.9 s** [−17.8, −13.9]. Webster retiming, which moves green away from the flyover arms,
saves another **3.1 s** [−4.4, −1.8]. Mean delay counts every generated vehicle, including
trips still under way or waiting to enter at the end of the run. Each variant's table shows
runs that ended gridlocked, runs whose entry queue was still growing, and diverted trips.

## The model in one paragraph
Road width is divided into lateral **strips** of 0.25 m, anchored at the kerb. A vehicle
occupies the strips covered by its width plus a calibrated lateral clearance. It follows the
nearest **rear end** among the vehicles overlapping its strips, using **IDM** with a
synchronous ballistic update (dt = 0.2 s).
- **Lateral movement:** generalised **MOBIL** over strip offsets, with route bias, safety checks
  for both the follower and the mover, and a deterministic commit order. Lane mode is the
  special case where one strip equals one lane, and it reduces to classic MOBIL.
- **Junctions:** movement-specific signals (protected and permissive, amber, all-red), gap
  acceptance (critical gap and follow-up headway; reproduces Harders' capacity), commitment,
  merging and diverging, conflict areas from intersecting swept paths, don't-block-the-box,
  spillback and per-junction gridlock detection. Vehicles are never teleported.
- **Flyovers:** separate layers that meet the ground only through ramps.
- **Randomness:** every draw comes from a per-entity substream. The same seed gives
  bit-identical results in Node, Chromium and WebKit (tested; Firefox is untested because
  Playwright's Firefox would not launch on the development machine). Changing a signal plan or
  adding a flyover never changes who arrives when.

Full specification: [docs/MODEL.md](docs/MODEL.md). Decisions and their reasons:
[docs/DECISIONS.md](docs/DECISIONS.md).

## Validation and honest limitations
See [docs/VALIDATION.md](docs/VALIDATION.md). In short:
- **Data checks:** line-count flow (6,095 veh/h) agrees with the paper's 6,010 veh/h. The
  dataset's speed column is 1.92× lower than speeds computed from positions, so it isn't used.
  The paper's own density figure is internally inconsistent, and the report says so.
- **Provenance:** every vehicle parameter is labelled derived, proxy or assumption.
  - s0 is assumed.
  - v0 is a proxy.
  - a and b depend on the smoothing window (a table shows by how much).
  - T is conditional on s0 and v0 (a sensitivity table shows by how much).
- **Fundamental diagram:** the Chennai points cover the free-flow branch only. They do not
  validate capacity or the effects of road width.
- **Simulated vs observed:** a simulated 11.2 m road at 6,000 veh/h runs at 47 km/h and
  129 veh/km, against 41 km/h and 148 veh/km observed. This is documented, not tuned.
  - **Likely reasons:** v0 is a p85 proxy, T depends on the assumed s0 and v0, and there is
    no roadside friction.
  - **Sensitivity:** cutting v0 by 10% gives 42.1 km/h, which explains 84% of the gap.
- **Vehicle widths:** measured widths are capped at 2.6 m as a data correction. 44 of 95 buses
  measured up to 3.27 m wide, likely from the video measurement or from mirrors.
- **Lateral speeds:** taken from deliberate moves, as p85 of the peak lateral speed of moves of
  at least 1 m. Motorcycle 0.86, car 0.78, auto 0.63, bus 0.61 m/s (from 18 moves, a small
  sample). Trucks borrow the bus value and LCVs the car value, both labelled assumptions.
- **On-ramp merging:** saturates at about 2,850 veh/h. The preset (2,000 + 500 veh/h) runs 10
  seeds with no gridlock. At 2,400 + 600 veh/h, one seed in 10 jams; this is not yet traced.
- **Not modelled:** merging at lane drops. Vehicles enter already sorted into the continuing
  lanes.
- **Silk Board:** demand is plausible, not observed.
  - **Old preset (about 2,950 veh/h):** 10 seeds locked 10.9 ± 3.2 junctions each (5–18).
    960 trips completed and 1,746 did not. Entry queues were around 590, and speed was around
    6 km/h.
  - **Causes found and fixed:**
    - a swap deadlock at a diverge, now broken by rerouting;
    - wide buses that could never enter, or never reach, a narrow lane band, because the
      0.25 m grid had no position that fitted. These buses also had over-wide measured widths.
    - The rest is spillback from oversaturated signals.
  - **New preset:** 1,770 veh/h (60% of the old demand). In all 10 seeds, entry queues stay
    bounded, the number of vehicles in the network stays flat and no junction locks. Mean delay
    is 49.3 ± 5.2 s.
  - **Thresholds:** locks and growth inside the network start at 70%. Entry queues keep
    growing only at 100%.
  - **Diversions:** about 6% of trips are diverted to another exit by the deadlock breaker.
- **Collision guard:** 65 activations per 1,000 vehicle-km on the Silk Board preset, 23 on the
  4-arm junction and 0 on corridors. At the old Silk Board demand, the rate per vehicle-km is
  about 1.8 times the previous engine's. This is documented, not hidden.
- **Lighthouse** (deployed, mobile): Performance 95, Accessibility 100, Best Practices 100.

## Repository
| Path | Contents |
|---|---|
| `packages/engine` | Simulation engine, pure TypeScript with no DOM or React. zod schemas form the shared contract. |
| `apps/web` | Vite + React + Tailwind app: Canvas2D renderer, simulation worker, experiment worker pool, uPlot charts. |
| `data-pipeline` | Python 3.12 (uv): Chennai calibration and the OSM → SUMO netconvert → network JSON conversion. |
| `data` | Raw inputs. The Chennai `.xlsx` files are not committed; `osm/silkboard.osm` is. |
| `docs` | Model spec, decisions, testing, validation, emitted JSON Schemas and shared test fixtures. |

## Run it locally
```bash
pnpm install
pnpm --filter @weave/web dev          # app at http://localhost:5173
pnpm typecheck && pnpm test           # engine: theory, unit and property tests
pnpm --filter @weave/web e2e          # UI checks on the production build (desktop + mobile)
node packages/engine/bin/weave.mjs --scenario weave-run-….json   # replay an exported run: same final state hash
cd data-pipeline && uv sync && uv run pytest
uv run python build.py                # rebuild the network and calibration (needs data/chennai/*.xlsx)
pnpm --filter @weave/engine sync-classes
```

## How it was built and tested
- **Specification first:** every milestone started with the spec in `docs/MODEL.md`.
- **Independent tests, committed failing:** a separate test-author agent wrote the tests from
  the spec without reading the implementation, and they were committed failing (`test:`
  commits) before the code. Expected values come from theory, computed inside the tests, or
  from cited papers.
- **Theory checks include:** IDM equilibrium and string stability, the fundamental diagram,
  Harders' gap-acceptance capacity, Webster's effective green, LWR shockwave speed, Little's
  law, conservation at every step, a no-collision property, t-interval coverage and common
  random numbers.
- **Test counts:** engine 322, data 106, end-to-end 103 (desktop and mobile, plus the hash
  checks in WebKit). One end-to-end test exports a run from the browser and replays it with the
  Node CLI to the same state hash. The end-to-end tests include checks that the browser and Node produce
  identical state hashes.
- **When tests disagreed with the model:** the spec was fixed and the reasons recorded. Tests
  were never weakened; each disagreement went to a human decision. See TESTING.md and ADR-014
  to ADR-022.

## Data sources and citations
- **Trajectories:** Kanagaraj V., Asaithambi G., Toledo T., Lee T.-C. (2015). *Trajectory data
  and flow characteristics of mixed traffic.* Transportation Research Record 2491, 1–11. Data
  distributed by T. Toledo (Technion): https://toledo.net.technion.ac.il/?p=387. Raw files are
  not redistributed here.
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
