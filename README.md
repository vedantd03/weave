# Weave

**Agent-based simulation of mixed, non-lane-disciplined traffic** on road networks with
junctions, flyovers and roads of different widths. Vehicles are calibrated on Chennai
trajectory data. Everything runs in your browser: a deterministic TypeScript engine in Web
Workers, a React UI, and a static deployment with no server.

**Live app:** https://weave-4uz6.vercel.app

## What you can do
- **Pick a scenario:** a ring road, a corridor narrowing, a 4-arm signalised junction (with or
  without a flyover), an on-ramp merge, or **Silk Board, Bengaluru**, imported from
  OpenStreetMap with its flyovers and the double-decker.
- **Edit it without drawing geometry:**
  - **Network:** arm count, angles and widths; flyover on or off, with deck, ramp and landing
    widths; corridor width changes and lane drops.
  - **Demand:** the origin–destination table and the vehicle mix.
  - **Signals:** the plan (phase greens, amber, all-red, offset).
  - **Behaviour:** strip mode (mixed traffic) or lane mode (theory check), and box compliance.
  - **Run settings:** duration, warm-up, time step and seed.
- **Watch it live:** vehicles coloured by class, signal heads, flyovers drawn above the box,
  live charts, the collision-guard rate and gridlock notices.
- **Run experiments:** *N* seeds in parallel workers, with means and 95% Student-t intervals.
  You can compare "flyover off", "flyover on with the same timings" and "flyover on, retimed"
  using **paired** intervals over common random numbers, then export to CSV.

**Example result** (4-arm preset, 5 paired seeds): the flyover cuts mean delay by **14.5 s**
[−15.0, −14.0]. Webster retiming, which moves green away from the flyover arms, saves another
**2.4 s** [−4.3, −0.5].

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
  bit-identical results in every browser and in Node, and changing a signal plan or adding a
  flyover never changes who arrives when.

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
  125–133 veh/km, against 41 km/h and 148 veh/km observed. This is documented, not tuned.
- **Not modelled:** merging at lane drops (vehicles enter pre-sorted); on-ramp merging capacity
  is limited by the calibrated lateral speeds.
- **Silk Board:** demand is plausible, not observed. Some junctions lock within the hour at
  1,800–3,000 veh/h; the detector reports this rather than hiding it.

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
- **Test counts:** engine 282, data 98, end-to-end 52, on desktop and mobile. The end-to-end
  tests include checks that browser and Node produce identical state hashes.
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
