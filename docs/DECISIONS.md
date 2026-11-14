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
  compliance parameter (`boxCompliance`), because strict box-clearing doesn't describe Indian
  junctions.
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
