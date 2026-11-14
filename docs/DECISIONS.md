# Architecture decision records

Each record gives the decision, why we made it, and what follows from it. Records are numbered
and kept in order; a superseded record is marked, not deleted.

## ADR-001 Static site: the engine runs in a Web Worker
**Decision:** The app is a TypeScript engine running in a Web Worker in the viewer's browser,
deployed as a static site on Vercel. There is no backend, no accounts and no database.

**Why:** Reviewers must find the app working whenever they open it. A static site has no server
that can sleep or fail, and the computation runs on each viewer's machine.

**Consequences:**
- A headless Node runner uses the same engine for tests and for reference results.
- Multi-seed experiments run in a pool of workers.
- Shareable state lives in the URL hash.

## ADR-002 Bit-identical results across JS engines
**Decision:** The engine hot path uses only IEEE-754-exact operations (`+ − × ÷ sqrt`). IDM with
δ=4 is computed by multiplication, and logarithms come from our own arithmetic `dln`.

**Why:** ECMAScript doesn't require `Math.exp/log/pow/sin` to be correctly rounded, so V8, JSC
and SpiderMonkey can differ in the last bit and trajectories drift apart.

**Consequences:** The same seed gives the same state hash in Node, Chrome, Safari and Firefox, and
an e2e check compares the browser hash with the Node hash.

## ADR-003 Road width as lateral strips; lane mode as a special case
**Decision:** Road width is divided into strips of about 0.3 m that tile the road exactly
(`n = round(W/Δ)`). A vehicle occupies the strips covered by its width plus a clearance on each
side, `c(v) = c0 + c1·v`. In lane mode the strip width equals the lane width and a vehicle
occupies its whole lane.

**Why:** Mixed traffic in India is not lane-disciplined. Two-wheelers filter through gaps that a
lane model cannot represent.

**Consequences:** Classic lane behaviour is a testable special case (T9, T10).

## ADR-004 Lateral behaviour: generalised MOBIL over strip offsets
**Decision:** Lateral targets within reach are scored with the MOBIL incentive and a safety
criterion, plus a route bias. Lateral speed is capped, and a vehicle in mid-manoeuvre occupies
the full span it sweeps.

**Why:** Strips describe where vehicles are, not how they decide to move. Using MOBIL means lane
mode reduces exactly to the standard model.

## ADR-005 IDM with a synchronous ballistic update
**Decision:** Every step, all vehicles' accelerations are computed from one snapshot, then all
vehicles move by ballistic integration with the stop condition. The fixed step is dt = 0.2 s.

**Consequences:**
- **Lateral conflicts:** lateral decisions from the same snapshot are committed front-to-back
  in the order `(s desc, id)`, each re-checked against the occupancy already committed.
- **Leader rule:** the leader is the vehicle with the nearest *rear end* among vehicles
  overlapping the follower's strips, searched across link ends along the route.

## ADR-006 Junction model
**Decision:**
- **Movement paths:** each movement is an internal path. Conflict areas are computed
  geometrically from intersecting swept paths, by one module shared by the generators and the
  imported network.
- **Signals:** movement-specific signal groups (protected and permissive).
- **Priority:** gap acceptance with commitment. A committed vehicle reserves the conflict area.
- **Entering the junction:** a vehicle enters only when there is space beyond, with a
  compliance parameter (`boxCompliance`, default 1.0). Lower values are an editable
  assumption labelled as such in the UI. Nothing published supports a specific value such as
  0.7, so none is assumed.
- **Gridlock:** gridlock is detected and reported, never resolved by teleporting vehicles.
- **Layers:** conflicts exist only between movements at the same node, so a flyover never
  conflicts with the junction below it.

## ADR-007 Common random numbers through per-entity substreams
**Decision:** Every random draw comes from `substream(seed, purpose, entity)`, using
xoshiro128** seeded by a mixing hash. Arrivals use one stream per origin. Each vehicle's
destination, class, size and driver parameters come from that vehicle's own stream.

**Why:** Per-*purpose* streams are not enough. One extra draw anywhere would shift every later
draw in that stream, and paired comparisons between scenarios would stop being paired.

## ADR-008 Routes are fixed at generation from an OD table
**Decision:** Demand is an origin–destination table over zones whose IDs stay the same across
generator variants. When a vehicle is generated, its destination is drawn and its route is fixed
as the shortest path by free-flow time. Vehicles never choose turns at each junction.

**Why:** With the flyover on, a vehicle passes through a different number of junctions.
Per-junction draws would send the same vehicle somewhere else and break the comparison.

**Consequences:** T21 checks that toggling the flyover leaves every vehicle's generation time,
origin, destination, class, size and driver parameters bit-identical.

## ADR-009 Statistics
**Decision:**
- **Confidence intervals:** 95% intervals use Student-t (n seeds, n−1 degrees of freedom).
- **Comparisons:** scenario comparisons use paired t-intervals on the per-seed differences under
  common random numbers.
- **Warm-up:** a warm-up period is excluded from the results.
- **Incomplete trips:** reported, not dropped.

## ADR-010 Data pipeline: offline Python, derived JSON committed
**Decision:**
- **Chennai trajectories** (Kanagaraj et al., 2015) are processed by Python (uv, 3.12). The raw
  .xlsx files are provided locally and never committed; only derived parameters are committed.
- **Kinematics:** speeds and accelerations are recomputed from positions, because the
  dataset's speed and acceleration columns are about 1.9× too low.
- **Provenance:** every parameter carries `derived`, `proxy` or `assumption`.
- **Network:** the OSM extract for Silk Board is converted offline with SUMO `netconvert`, then
  into our JSON. Nothing from SUMO ships in the app.

## ADR-011 Shared contract as zod schemas
**Decision:** The zod schemas in `packages/engine/src/schema` are the single source of truth.
TS types are inferred from them, and JSON Schema is emitted to `docs/schema/` for the Python
pipeline. Messages crossing the worker boundary are validated with zod. The hot path never
calls zod.

## ADR-012 Scenario editing through parametric generators
**Decision:** Users edit parameters, not geometry. Generators cover:
- an N-arm junction (3–6 arms, arm widths, signal or priority control);
- an optional flyover with ramp and landing widths;
- a corridor with a width change or lane drop;
- a merge;
- a ring, used for tests and demos.

Silk Board stays a fixed imported network.

## ADR-013 Rendering
**Decision:** Canvas2D draws road surfaces from geometry, with flyovers on top with a drop shadow.
There are no map tiles, since they would be an external service. Frames are transferable
Float32Arrays with stride 7 (x, y, heading, class, length, width, layer). Length is per vehicle
because sizes vary within a class.

## ADR-014 Mover self-safety and safety-checked commits (M2)
**Decision:** a lateral move also requires `ã_c ≥ −B_SAFE` for the vehicle making it. Moves
committed in the same step are re-checked pairwise against the same B_SAFE criteria, not only
against an s0-widened overlap.

**Why:** the clearance test found a motorcycle at 8.4 m/s moving in behind a car at 4.5 m/s
that it could not avoid even at B_MAX. It also found two same-step moves into adjacent space a
few metres apart.

**Consequences:** lane mode is MOBIL plus a self-safety constraint. That is a stricter
condition, and no T10 scene is affected.

## ADR-015 Kinematic collision guard (M2)
**Decision:** after integration, a front never passes its snapshot leader's new rear (or a
standing obstacle). Speed is capped at the leader's speed when the guard binds. Every
activation is counted (`sim.diagnostics().guardActivations`) and reported.

**Why:** IDM is collision-free only while leaders brake within their limits. Dense mixed traffic
with lateral cut-ins can break that by centimetres. SUMO addresses the same problem with
safe-speed models.

**Consequences:** the guard does not change `VehicleView.a`, and it never binds in the theory
regimes (T3–T5). After the M3 counting fix (only real reductions count), it never binds on
corridors and binds 0.05–0.3 times per 10k vehicle-steps at junctions (VALIDATION.md §7).

## ADR-016 Route-band rules (M2)
**Decision:**
- **Insertion:** if any candidate fits the next movement's band, only in-band candidates are
  considered. Otherwise the vehicle waits in the queue.
- **Band keeping:** discretionary moves never take a vehicle out of the band it needs.
- **Route bias:** `β = min(1, 200/d)`.

**Why:** the diverge test deadlocked. Two vehicles each needed the other's lane, side by side
and stopped at the split.

**Consequences:** deadlocks of this kind are no longer created by insertion or by discretionary
moves. A vehicle that arrives in the wrong band from upstream can still be blocked. M3's
gridlock detector reports that, rather than hiding it.

## ADR-017 Calibrated classes are the default (M2)
**Decision:** `defaultClasses()` returns the Chennai-calibrated `classes.json`, with provenance
labels. The pipeline writes it to `apps/web/public/data/`, and `pnpm sync-classes` bundles an
identical copy in `packages/engine/data/`. The engine test run fails if the two copies differ.
The pre-calibration defaults remain available as `provisionalClasses()`.

## ADR-018 Occupancy evaluated in specification order (M2)
**Decision:** `occupiedStrips` computes `y − width/2 − c` exactly as written in the spec.

**Why:** insertion places clearance edges exactly on strip boundaries, where regrouping the
arithmetic changes the rounded strip index. The engine and every spec-literal implementation
(the tests, the Python leader rule) must agree to the bit.

## ADR-019 Fixed, kerb-anchored strip grid (M2 fix)
**Decision:** strips have a fixed width Δ = 0.25 m, anchored at each segment's left edge. A
movement's grid is offset so it continues its approach link's grid. Each segment no longer tiles
its own width exactly.

**Why:**
- **The defect:** the user found on the live app that strip mode lost about 40% of its capacity
  at a lane drop. The node-saturation test reproduced it on a mere 7.2 → 7.0 m narrowing.
- **The cause:** per-segment tiling (`W/round(W/Δ)`) misaligned the grids, so vehicles that were
  legally side by side landed in overlapping strips downstream and braked at B_MAX.
- **Why 0.25 m:** it divides the IRC lane widths 3.0, 3.25 and 3.5 m, so lane-based junction
  bands line up too (user decision).

**Consequences:** the narrowing now carries the same flow as the plain road. T changed by less
than 3%.

## ADR-020 Strict route bands; merging at lane drops not modelled (M2 fix, user decision)
**Decision:** keep strict band-only insertion and band keeping.

**Why:** a band zone (band rules within 150 m of the node only) made vehicles use the dropped
lane. Without a zipper or forced-merge model, saturated throughput then collapsed in both modes.
Cooperative yielding removed swap deadlocks at diverges but turned merges into stop-and-go.

**Consequences:**
- The lane-drop preset is renamed "Corridor narrowing (vehicles pre-sorted)".
- A merge model is future work.

## ADR-021 Kinematic gap floor for lateral moves (M2 fix)
**Decision:** a lateral move needs gaps of at least `max(v·dt + ½·a⁺·dt² + 0.1 m, ½·s0)` to the
new leader and from the new follower, including in the same-step commit re-check.

**Why:** a follower could close a few-centimetre gap within the same synchronous step, before
the move was visible to it.

**Why not s0:** a floor of s0 blocked zipper-like squeezes at standstill.

## ADR-022 Junction rule refinements (M3, found on generated presets and Silk Board)
**Decision:** each of these fixes a deadlock or a capacity collapse that was traced to its root
cause.
1. **Don't block the box applies at junction nodes only** (≥ 2 movements). Otherwise it held
   vehicles at a ring's seam and at corridor tapers.
2. **Box space is measured along the route** across short segments. Silk Board has 7 m exit
   links that could never hold length + s0.
3. **The box rule counts only a standing queue** (speed < 2 m/s). Moving traffic is
   car-following's job; counting it throttled free merges.
4. **A band is never wider than its movement**, and vehicles wider than their road may make any
   move that reduces the overflow.
5. **Band-seeking moves need only the body inside the road.** Edge clearance otherwise made a
   2.69 m bus unable to reach a 3.0 m movement.
6. **Merge projections include approaching vehicles only if they will enter.** That excludes
   vehicles at a red or amber, yielding, or stopped.
7. **Standing obstacles are exempt from the mover's gap floor and self-safety checks.** A vehicle
   at the end of an acceleration lane could otherwise never edge across.
8. **Lateral decisions evaluate spans with the clearance they will freeze at commit** (c1 > 0).

**Why:** each rule was traced to a specific defect.

**Consequences:** the 247 engine tests still pass. The generated junction presets flow; for
example, the 4-arm preset now exits 679 of 738 vehicles in 15 min, against 63 before.


## ADR-023 Deadlock breaker and unchanged-follower rule (M5 revision, traced on Silk Board and the on-ramp)
**Context:** two deadlocks remained after ADR-022. Each was traced vehicle by vehicle, following
"who waits for whom":
1. **Swap deadlock at a diverge** (Silk Board, link 1155963376#1). Vehicles reached the end of a
   link in the wrong lane band for their next movement and stood side by side. Each blocked the
   strips the other needed.
2. **End of an acceleration lane** (on-ramp, 1–2 seeds in 10 at any demand). A stopped car had
   a motorcycle 0.05 m behind it, overlapping both its current and its target strips. MOBIL
   treated the motorcycle as a "new follower" and rejected every sideways move on its gap floor.

**Decisions:**
1. **Deadlock breaker (MODEL.md §2.2):** after 20 s stuck at a lane-band obstacle, a vehicle
   takes the alternative movement whose band it fits best and is rerouted from there.
   - **Unreachable destination:** if the destination can no longer be reached, the vehicle
     goes to the nearest reachable exit and is counted as diverted.
   - **Reporting:** reroutes and diversions are reported.
2. **Unchanged follower (MODEL.md §2.4):** if the new follower is the vehicle that already
   follows the mover (N = O), the move changes nothing for it. Its gap-floor and B_SAFE checks
   and both politeness terms are skipped. In lane mode, spans of adjacent lanes never overlap,
   so classic MOBIL is unchanged.

**Rejected:**
- **Cooperative yielding near diverges:** it made Silk Board lock at most nodes in all seeds.
- **A "forced merge" that relaxed the gap floor after a long wait:** it did not address the
  cause, a gap that does not change.

**Consequences:**
- **On-ramp:** the preset (2,000 + 500 veh/h) went from 5/10 gridlocked runs to 0/10, and the
  merge section saturates at about 3,000 veh/h.
- **Silk Board:** locks now start only above 60% of the old demand.
- **Diversions:** about 6% of Silk Board trips are diverted (VALIDATION.md §9).
- **Testing:** both rules were implemented during timeboxed investigations, before their
  tests. The test-author agent then wrote tests for them from the spec. This breaks the usual
  test-first order, and the commit says so.

## ADR-024 Delay includes unfinished trips (user decision)
**Context:** the mean delay over completed trips hid gridlock and entry queues. A run where
half the vehicles never left could look good.

**Decision:** `meanDelayS` covers every generated vehicle.
- **Unfinished trips:** delay so far is run end − generation time − free-flow time for the
  distance actually travelled. That is 0 m for vehicles still in the entry queue.
- **Accounting check:** total delay equals vehicle-seconds in the system minus the free-flow
  time travelled.
- **Comparison metric:** `meanDelayCompletedS` keeps the old mean.
- **Gridlocked runs:** runs with a locked junction at the end are flagged `gridlocked` and
  counted in the Experiments view.

**Rejected:** subtracting the whole route's free-flow time from unfinished trips. That
undercounts their delay, and it could even make it negative.
