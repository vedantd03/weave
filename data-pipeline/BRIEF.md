# Data agent brief

This brief is binding and comes from the main agent. Follow it together with `/CLAUDE.md`.

## Scope
**Files you may write:**
- `data-pipeline/**`
- `data/osm/**`
- `apps/web/public/data/*.json`

**Files you may only read:**
- `data/chennai/*.xlsx`: never write, move or commit these. If they are missing, do every step
  that doesn't need them and report that you are blocked.
- `docs/schema/*.schema.json` and `docs/fixtures/*`.

**Not allowed:**
- Committing.
- Adding dependencies. The approved ones are numpy, pandas, scipy, openpyxl, jsonschema,
  eclipse-sumo and pytest; ask the main agent for anything else.
- Editing the schemas. If the contract seems wrong, report it.

**External access:** one Overpass API download of the Silk Board area, committed as
`data/osm/silkboard.osm`. Record the query and the download date in `data/osm/README.md`.

## Order of work
1. **Silk Board network:** OSM extract, then `netconvert`, then our network JSON
   (`apps/web/public/data/silkboard.json`).
   - **netconvert:** join junctions, keep layers and bridges, and keep internal lanes for the
     path geometry.
   - **Local metres:** project around the area centre with equirectangular x/y in metres, and
     record the origin lat/lon.
   - **Widths:** each link's `widthM` is the sum of its lane widths. Where OSM has no width,
     use the defaults per road class and note them.
   - **Zones:** one zone at each boundary link, with IDs that stay stable between runs.
   - **Flyover:** flyover and ramp links get `layer ≥ 1` and stay unconnected to the roads
     below except through ramps.
   - **Movements:** `fromLateral` and `toLateral` bands come from the lane indices of the
     connections. Put netconvert foes in `foes` (a cross-check only). Leave `conflicts` empty;
     the engine computes them.
   - **Signals:** include netconvert's default signal programmes as `signals`. They are
     editable defaults.
   - **Fixes:** apply any hand fixes from `data-pipeline/patches/silkboard.json`, each with a
     reason.
2. **Synthetic tests:** D1 (speed recovery) and D8 (calibration estimators) on synthetic data.
3. **Once `data/chennai/` has the files:** kinematics, D6, clearance, leaders, calibration,
   then `classes.json` and `chennai_fd.json`.

## Kinematics
- **Don't use the reported columns:** the dataset's speed and acceleration columns are about
  1.92× too low relative to the positions.
- **Recompute from smoothed positions:** longitudinal speed, longitudinal acceleration and
  lateral speed. Smooth first (Savitzky–Golay or local regression), then differentiate, with
  jerk and physical-bound checks.
- **Flagged rows:** drop rows with flag ≠ 0 from microscopic fits.

## D6, with corrections
- **Don't use 128 veh/km:** the earlier figure was wrong. It covered the whole section,
  including the ends where vehicles weren't tracked yet.
- **Don't use the paper's 123.5 veh/km as an expected value either:** 6,010 / 123.5 = 48.7 km/h,
  which contradicts the paper's own speeds. Record this inconsistency for VALIDATION.md.
- **Tracked region:** determine from the data the x-range where tracking is complete, and use
  only that region.
- **Flow:** count vehicles crossing several virtual lines inside the tracked region, and compare
  with the paper's 6,010 veh/h. Derive the tolerance from the Poisson counting error plus the
  spread between lines.
- **Speed ratio:** compute the ratio of position-derived speed to the speed column. Assert it is
  stable across classes, files and speed bins, and clearly ≠ 1. Report the value; don't
  hard-code it.
- **Density:** Edie density `k = Σ time / (L·T)` over the tracked region and period must agree
  with line-count flow ÷ space-mean speed over the same region and period.
- **General rule:** no expected number unless it traces to the paper or is computed in this
  session.

## Parameters
Write `classes.json` in the format of `docs/schema/classes.schema.json`. Every value carries a
provenance and a note.
- **a, b:** percentiles of the position-derived acceleration, never the dataset's acceleration
  column. State which percentiles you used. Provenance `derived`.
- **v0:** the per-class 85th-percentile position-derived speed. Provenance `proxy`; the note
  says traffic is near capacity at about 41 km/h, so free-flow vehicles are rare.
- **s0:** a literature default with its citation. Provenance `assumption`; the data has almost
  no slow or stopped following.
- **Clearance:**
  - **Estimator:** a low percentile (p10) of the lateral gaps drivers accept between
    neighbouring vehicles, not the median gap they keep.
  - **Halving:** each gap is split between its two vehicles (c = gap/2), because the engine adds
    clearance on both sides. A median would make motorcycles too wide to filter.
  - **Sensitivity:** report p5 and p15 too.
  - **Speed slope:** fit c1 only if individual speeds cover enough range to identify it.
    Otherwise set c1 = 0 with provenance `assumption`.
- **T:**
  - **Estimator:** invert the IDM steady state on steady-following samples (small |a|, small
    |Δv|): `T = (s·√(1 − (v/v0)⁴) − s0)/v`, then take the per-class median.
  - **Label:** conditional on the assumed s0 and the proxy v0.
  - **Sensitivity:** a table of T under s0 ± 1 m and v0 ± 10%.
- **Leaders:** use exactly the engine rule in docs/MODEL.md §1.5–1.6: strips that tile the road,
  occupancy `[floor(left/w), ceil(right/w) − 1]` with width + 2c, and the nearest *rear end*
  among overlapping vehicles ahead. D7 must reproduce `docs/fixtures/leader_cases.json`.
  Estimate clearance before finding leaders.
- **Sizes:** motorcycle and auto-rickshaw sizes are fixed constants in this dataset, so give
  them provenance `assumption`, not `derived`. Car, bus, truck and LCV sizes are `quantiles`
  distributions (0, 5, …, 100%) with provenance `derived`.
- **Shares:** class shares from vehicle counts, provenance `derived`.
- **Fields the data doesn't identify:** gap acceptance (criticalS, followUpS) and lateral
  parameters (maxSpeedMps from the p95 of position-derived |lateral speed| is `derived`;
  politeness and threshold are `assumption`).

## `chennai_fd.json`
Per-minute points (flow veh/h, Edie density veh/km, space-mean speed km/h) over the tracked
region. Mark the file as covering the free-flow branch only: minute speeds span roughly
36–45 km/h, so it says nothing about capacity or road-width effects.

## Tests
- **D1:** speed recovery on synthetic noisy trajectories.
- **D2:** class mapping and units.
- **D3:** flag filtering.
- **D4:** network topology (references, connectivity, layers).
- **D5:** schema validity of every output.
- **D6:** described above.
- **D7:** leader-rule parity with the fixture.
- **D8:** the clearance and T estimators recover known values on synthetic data.

## Report back
- Every derived value with its provenance and note.
- The D6 numbers (line-count flow, speed ratio, density agreement).
- The sensitivity tables.
- Any netconvert patch entries.
- Open issues.
