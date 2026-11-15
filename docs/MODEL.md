# Weave model specification

This is the specification the engine is built and tested against. Tests derive their expected
values from the equations here, never from engine output and never by calling the engine's own
helper that computes the same quantity. Where this document and the code disagree, the
document wins until the main agent changes it. Sections marked *(Mn)* become binding at
milestone n.

## 0. Conventions

- **Units:** SI throughout: m, s, m/s, m/s². Field names carry the unit (`widthM`, `rateVph`).
  The UI converts to km/h.
- **Coordinates:** local metres, x east, y north. Arc length `s` runs along a link's polyline
  from its start. A vehicle's `s` is the position of its **front**.
- **Lateral coordinate:** `y` is the position of the vehicle's **centre**, measured from the
  **left** edge of the carriageway in the direction of travel. This matches the Chennai data.
- **Link polylines** are carriageway **centrelines**. The world position of `(s, y)` is
  `P(s) + nL(s)·(widthM/2 − y)`, where `nL` is the unit left normal (the tangent rotated
  +90°). Movement paths are centrelines too.
- **Frames** carry the vehicle body's **centre** (x, y) in world metres and its heading in
  radians, counter-clockwise from +x.
- **Determinism:**
  - The simulation hot path uses only `+ − × ÷`, `Math.sqrt`, `Math.floor`, `Math.ceil`,
    `Math.min`, `Math.max` and `Math.abs`. These are exact under IEEE 754 or are pure
    selection.
  - `Math.pow`, `exp`, `log`, `sin`, `cos` and `atan2` are **not** used in state updates,
    because ECMAScript doesn't require them to be correctly rounded. Geometry (polyline
    headings for rendering) may use them, since it doesn't feed back into state.
  - Logarithms come from `dln` (§1.1).
- **Fixed step:** `dt = scenario.dtS`, 0.2 s by default.

## 1. Core (M1)

### 1.1 Deterministic natural log: `core/dmath.ts`

```ts
export function dln(x: number): number
```

- **Special values:** `dln(x)` is NaN for x < 0 or NaN, −Infinity for x = 0 and +Infinity for
  +Infinity.
- **Accuracy:** for finite x > 0 the result is within 1 ulp of the true ln x. It uses only
  arithmetic, so every JS engine returns the same bits (fdlibm `__ieee754_log` algorithm with
  exponent extraction done arithmetically).

### 1.2 Random streams: `core/rng.ts`

```ts
export class Rng {
  constructor(seed: number)          // seed: any uint32
  nextU32(): number                  // uniform integer in [0, 2^32)
  next(): number                     // uniform in [0, 1): nextU32() / 2^32
  uniform(lo: number, hi: number): number   // lo + (hi - lo) * next()
  exponential(rate: number): number  // -dln(1 - next()) / rate   (mean 1/rate)
}
export function mix32(...values: number[]): number   // avalanche hash of uint32 inputs → uint32
export const Purpose: { readonly arrivals: 1; readonly vehicle: 2; readonly driver: 3; readonly init: 4; readonly gap: 5 }
export function substream(seed: number, purpose: number, entity: number): Rng
```

- **Generator:** xoshiro128** with 32-bit state words updated through `Math.imul` and `>>>`.
  Its 128-bit state is seeded by running splitmix32 from the seed. Exact definitions (all
  arithmetic is uint32):
  - **`fmix32(h)`:** `h ^= h>>>16; h = imul(h, 0x85ebca6b); h ^= h>>>13; h = imul(h, 0xc2b2ae35); h ^= h>>>16`.
  - **`splitmix32` step:** `state = (state + 0x9e3779b9)>>>0`, returning `fmix32(state)`.
  - **Seeding:** `Rng(seed)` sets s0..s3 to four successive splitmix32 outputs from
    `state = seed>>>0`. If all four are 0, s0 = 1.
  - **`nextU32` (xoshiro128\*\*):** `r = imul(rotl(imul(s1,5),7),9); t = s1<<9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3,11)`; return `r>>>0`.
  - **`mix32(...v)`:** `h = 0x811c9dc5`; for each value: `h = fmix32((h ^ (v>>>0)) + 0x9e3779b9)`.
  - **Rounding:** "round" in this spec always means half-up, `floor(x + 0.5)` (JS `Math.round`
    for positive x). The Python pipeline must use the same rule, not banker's rounding.
- **Substreams:** `substream(seed, purpose, entity)` = `new Rng(mix32(seed, purpose, entity))`.
- **Common random numbers:** every random quantity belongs to exactly one *(purpose, entity)*
  substream:
  - **arrivals:** entity = origin zone index. Interarrival times.
  - **vehicle:** entity = vehicle id, where the id is assigned as
    `originIndex * 2^20 + k` for the k-th vehicle from that origin. Destination, class, length
    and width.
  - **driver:** entity = vehicle id. Per-driver parameter multipliers.
  - **init:** entity = 0. Initial placement jitter.
  - **gap:** entity = vehicle id. Gap-acceptance draws.

  So changing anything downstream (signals, flyover) cannot change what is drawn for a vehicle.

### 1.3 IDM: `models/idm.ts`

```ts
export interface IdmParams { v0: number; T: number; s0: number; a: number; b: number }
export const B_MAX = 9  // physical braking limit, m/s²
export function idmAccel(p: IdmParams, v: number, gap: number, dv: number): number
```

- **Inputs:** `gap` is the net gap to the leader's rear (m), or `Infinity` with no leader.
  `dv = v − v_leader` is the approach rate.
- **Free-road term:** with r = v / v0, `free = 1 − r⁴`, computed as `r2 = r*r; r2*r2`.
- **Desired gap:** `s* = s0 + max(0, v·T + v·dv / (2·√(a·b)))`.
- **Acceleration:** `acc = a · (free − (s*/gap)²)`, and `acc = a · free` when the gap is
  infinite.
- **Clamp:** the result is clamped to `[−B_MAX, a]`. If `gap ≤ 0` the result is `−B_MAX`.
- **Speed limit:** in the simulation, the effective desired speed is
  `min(v0_driver, speedLimitMps)` of the link the vehicle's front is on. `idmAccel` itself
  takes whatever v0 it is given.
- **Equilibrium (for tests):** with dv = 0 and acc = 0, the equilibrium gap is
  `s_e(v) = (s0 + vT) / √(1 − (v/v0)⁴)`.

### 1.4 Ballistic integration: `models/integrate.ts`

```ts
export function ballistic(x: number, v: number, a: number, dt: number): { x: number; v: number }
```

- **Normal step:** if `v + a·dt ≥ 0`, then `v' = v + a·dt` and `x' = x + v·dt + ½·a·dt²`.
- **Stopping within the step:** otherwise `a < 0`, so the vehicle stops: `x' = x − v²/(2a)`,
  `v' = 0`. A vehicle never reverses (Treiber & Kanagaraj, 2015).
- **Collision guard (simulation only, M2):** IDM is collision-free only while every leader
  brakes within its limits. In dense cut-in traffic a leader braking at B_MAX can leave a
  follower unable to stop.
  - **Rule:** after integration, a vehicle's displacement is capped so its front stays
    1e-6 m behind its snapshot leader's new rear (or behind a standing obstacle). When the
    cap binds, its speed is limited to the leader's speed (0 for an obstacle). Passes repeat
    until nothing changes.
  - **What it leaves alone:** the IDM acceleration (`VehicleView.a`) is unchanged.
  - **Reporting:** activations are counted by `sim.diagnostics().guardActivations` and
    reported. They are not hidden.
  - **Where and how far (revision 2):** `diagnostics().guardBySegment` maps a segment id
    (link or movement) to the activations that happened on it; only non-zero entries appear,
    and they sum to `guardActivations`. `diagnostics().vehicleKm` is the distance driven by
    all vehicles' fronts (§5.2). The live panel shows the rate per 1,000 vehicle-km.

### 1.5 Strips: `network/strips.ts`

```ts
export interface StripLayout { n: number; w: number; o: number }   // count, strip width Δ, grid origin offset
export function stripLayout(roadWidthM: number, stripM: number, originM?: number): StripLayout
export function laneLayout(roadWidthM: number, lanes: number): StripLayout
export function stripIndex(x: number, layout: StripLayout): number          // strip containing x
export function occupiedStrips(yCentre: number, width: number, clearance: number, layout: StripLayout): [number, number]
export function sweptStrips(yA: number, yB: number, width: number, clearance: number, layout: StripLayout): [number, number]
export function laneStrip(yCentre: number, layout: StripLayout): [number, number]
```

- **Layout (strip mode), revised in M2:** strips have a **fixed width Δ = `scenario.stripWidthM`**
  (default **0.25 m**). The grid is anchored at the segment's left edge, shifted by an origin
  offset `o ∈ [0, Δ)`.
  - **Boundaries:** the strip boundaries are `{o + kΔ : 0 < o + kΔ < W}` together with 0 and
    W. The first strip is `[0, o)` when o > 0, and the last strip may be narrower than Δ.
  - **Count:** `n = (o > 0 ? 1 : 0) + ceil((W − o)/Δ − 1e-9)`, with n ≥ 1.
  - **Index:** `stripIndex(x) = clamp(floor((x − o)/Δ + 1e-9) + (o > 0 ? 1 : 0), 0, n − 1)`.
  - **Links** use o = 0, so grids on consecutive kerb-aligned segments coincide.
  - **Movements** use `o = (−fromLateral[0]) mod Δ`, so the movement's boundaries continue
    its approach link's grid. Offsets within 1e-9 of 0 or Δ count as 0.
  - **Why it changed:** with a per-segment grid that tiles each width exactly
    (`w = W/round(W/Δ)`), grids misaligned wherever the width changed. Vehicles legally side
    by side upstream then landed in overlapping strips downstream and braked at B_MAX. A
    7.2 → 7.0 m narrowing lost about 30% of its capacity (node-saturation test).
  - **Why 0.25 m:** it divides the IRC lane widths 3.0, 3.25 and 3.5 m, so lane-based bands at
    junctions also land on grid boundaries.
- **Layout (lane mode):** `laneLayout(W, lanes)` = `{ n: lanes, w: W/lanes, o: 0 }`, so one
  strip is one lane. A movement in lane mode has
  `n = max(1, round(widthM / laneWidth(fromLink)))`.
- **Occupancy (strip mode):** the body plus clearance on both sides covers
  `[left, right) = [y − width/2 − c, y + width/2 + c)`, evaluated in exactly that order.
  - **lo** is `stripIndex(left)`.
  - **hi** is the strip containing `right` when right lies strictly inside a strip; when right
    is on a boundary, it is the strip just before that boundary. Equivalently,
    `hi = clamp(ceil((right − o)/Δ − 1e-9) − 1 + (o > 0 ? 1 : 0), 0, n − 1)`.
  - **Result:** the inclusive pair `[lo, hi]`.
  - **Tolerance:** the 1e-9 strip tolerance makes edges that land on a boundary, as they do
    for strip-grid insertion candidates, independent of rounding.
- **During a lateral manoeuvre** from yA to yB, the vehicle occupies
  `sweptStrips = [min(lo_A, lo_B), max(hi_A, hi_B)]`.
- **Occupancy (lane mode):** `laneStrip = [k, k]` with `k = clamp(floor(y / w), 0, n − 1)`.
  The vehicle occupies its whole lane regardless of its width.
- **Clearance:** `c(v) = c0 + c1·v` (class parameters, §4). For **occupancy**, every vehicle
  uses a *frozen* clearance `c_occ`, which is c(v) evaluated at its last lateral commit or at
  insertion (initial and added vehicles: `c(v_initial)`). Decisions (candidate fit,
  insertion) use c(v) at the current speed. This keeps a vehicle's span from growing on its
  own as it accelerates, which with c1 > 0 could otherwise create overlaps with no lateral
  move.

### 1.6 Leader rule: `sim/leader.ts`

```ts
export interface LeaderInput { front: number; length: number; lo: number; hi: number }
export function findLeaders(vs: readonly LeaderInput[]): Int32Array   // leader index or -1
```

- **Candidates:** for vehicle i, a candidate j ≠ i must overlap i's strips
  (`lo_j ≤ hi_i && lo_i ≤ hi_j`) and be ahead (`front_j > front_i`, or equal fronts with
  `j > i`).
- **Leader:** the candidate with the **smallest rear end** `front_j − length_j`, not the
  smallest front. Ties go to the smaller index.
- **Gap:** `gap_i = (front_L − length_L) − front_i`.
- **Shared rule:** this is the one rule used by the engine and by the data pipeline. Shared
  cases live in `docs/fixtures/leader_cases.json`. The engine (T8) and the pipeline (D7) must
  both reproduce them.
- **Fixture format:**
  `{ cases: [{ name, roadWidthM, stripWidthM, mode: 'strip'|'lane', lanes?, vehicles: [{ id, frontM, lengthM, centreM, widthM, clearanceM }], expected: { [id]: leaderId | null } }] }`
- **Look-ahead:** the **whole** search (own link plus continuation) is capped at
  `D = max(150 m, v²/(2b) + 50 m)` from the vehicle's front. A leader whose rear end is
  farther than D counts as no leader (free road). With IDM, the interaction term at that
  distance is negligible.
- **Across link ends:** in the running simulation, when no candidate exists on the vehicle's
  own link within the look-ahead distance, the search continues
  along the vehicle's route onto the next movement path and link. Positions there are offset
  by the remaining length of the current link, and strips map through the movement's lateral
  bands. A vehicle whose front has crossed onto the next link while its rear is still upstream
  is also registered as an occupant of the upstream link's end, so followers there see its
  tail.

### 1.7 Simulation: `sim/sim.ts`

```ts
export function createSim(input: { scenario: ScenarioInput; classes: ClassSet; network?: Network }): Sim
export interface VehicleView {
  id: number; classId: VehicleClassId; link: string; s: number; y: number; v: number; a: number;
  length: number; width: number; lo: number; hi: number
}
export interface Sim {
  readonly t: number; readonly step: number; readonly dt: number; readonly network: Network
  advance(steps?: number): void
  vehicles(): VehicleView[]            // sorted by id
  vehicleCount(): number
  stateHash(): string                  // FNV-1a over the IEEE-754 bits of (id, link, s, y, v) in id order
  counters(): { generated: number; exited: number; onNetwork: number; entryQueue: number }
  writeFrame(out: Float32Array): number  // fills FRAME_STRIDE records; returns vehicle count
}
export function generateNetwork(params: GeneratorParams): Network   // scenarios/generators
export function defaultClasses(): ClassSet                          // provisional until the pipeline lands
```

**Behaviour details:**
- **`stateHash`:** 32-bit FNV-1a (offset 0x811c9dc5, prime 0x01000193 via `imul`) over, for
  each vehicle in id order: id as uint32 LE (4 bytes), link index uint32 LE, then s, y and v as
  float64 LE (8 bytes each). The result is 8 lowercase hex digits.
- **`VehicleView.a`:** the acceleration used in the last step, computed from the pre-step
  snapshot.
- **`advance(n)`:** continues from the current state, so `advance(a)` then `advance(b)`
  equals `advance(a + b)`.
- **Ring:** the ring's own link is the next route element after itself. `s` stays in
  `[0, L)` by wrapping modulo L, and a gap across the wrap is `(L − s_i) + s_lead − ℓ_lead`.

**Update order for one step (synchronous):**
1. From the current state (a snapshot), compute every vehicle's leader and gap, then its IDM
   acceleration with its own class and driver parameters.
2. *(M2)* Compute lateral decisions from the same snapshot (§2).
3. Integrate every vehicle with `ballistic`.
4. Move vehicles whose front passed the link end onto their next route element, and remove
   vehicles that finished their route.
5. *(M2)* Generate arrivals and insert them from the entry queues.
6. Set `t ← t + dt` and `step ← step + 1`.

**Initial placement:**
- **Count and spacing:** each link gets `round(initialDensityPerKm · L / 1000)` vehicles,
  evenly spaced in `s`, where L is the link length.
- **Jitter:** each position is then jittered by `uniform(−j, j)` from the `init` substream,
  with j = `initialJitterM`.
- **Speed and lateral position:** initial speed is 0. Vehicle k goes at the centre of nominal
  lane `k mod lanes`.
- **Class and size:** classes come from the scenario composition and sizes from class
  distributions (`vehicle` substream).

**Ring generator (`generator: 'ring'`):**
- **Shape:** one link from node `n0` back to `n0`. Its polyline is a regular 360-gon scaled so
  that the polyline length equals `circumferenceM` exactly, so tests use L = `circumferenceM`.
- **Closing the loop:** one `free` movement at `n0` connects the ring to itself.
- **Demand:** none; vehicles come only from initial placement.

**Class sampling:**
- **Sizes:** sizes use the `Dist` inverse CDF: `fixed` returns the value; `quantiles` takes a
  uniform draw u and interpolates linearly between `q[⌊u(n−1)⌋]` and the next quantile.
- **Driver variation:** each per-driver parameter is `value · (1 + spread · uniform(−1, 1))`
  from the `driver` substream.

## 2. Mixed traffic (M2)

### 2.1 Zones, OD demand and routes
- **Zones:** origins are the `in` zones and destinations the `out` zones. `originIndex` is the
  zone's index among the network's `in` zones, in network order.
- **Arrivals:** origin o has total rate `λ_o = Σ_d rateVph(o,d) / 3600` (veh/s). Its arrival
  times come from substream `(arrivals, originIndex)`: `T_1 = exponential(λ_o)` and
  `T_{k+1} = T_k + exponential(λ_o)`. Origins with λ_o = 0 generate nothing.
- **Generation:** at the end of every step, after transfer, every arrival with `T_k ≤ t_new`
  is generated in order and appended to its origin's FIFO **entry queue**. The vehicle's id is
  `originIndex · 2^20 + (k − 1)`, and its generation time is `T_k` exactly.
- **Vehicle substream** `(vehicle, id)`, drawn in this exact order:
  1. **destination:** `u·λ_o` over that origin's OD rows, in table order;
  2. **class:** `u·Σshares` over the classes in ClassSet order, with shares from
     `compositionByOrigin[origin]`, or `composition` if absent;
  3. **length**;
  4. **width**;
  5. **lateral preference** `u_lat` (see §2.3).

  Initial vehicles (§1.7) use the same order with destination and lateral preference omitted.
- **Driver substream** `(driver, id)`: the multipliers for v0, T, s0, a, b, in that order.
- **Route:** the shortest path from the origin zone's link to the destination zone's link.
  - **Cost:** cost = Σ over segments of (length / speed limit + junction penalty). The penalty
    is **15 s** for a movement with control `signal`, **5 s** for `minor`, and 0 otherwise.
    - **Status:** the penalty values are an assumption, standing for expected junction delay.
    - **Why it exists:** without it, a flyover route (ramp R + deck + ramp R) and the at-grade
      route (R + 20 + box + R + 20) both measure 2R + 2r0 + 40 m in plan, so the deck would
      win only on a tie-break. Lengths are 2D polyline lengths; ramps are not measured in
      3D.
  - **Search:** Dijkstra over segments, where links lead to their movements and movements to
    their toLink. Ties go to the smaller segment index, then to the shorter path in segments.
  - **Caching:** routes are computed once per OD pair.
  - **Unreachable pairs:** an OD pair with rate > 0 and no path makes `createSim` throw.
- **Exit:** a vehicle leaves when its front passes the end of the last route element. It is
  counted in `exited` and its trip is recorded.

### 2.2 Lane-band rule

**Effective band:** a movement's band is `[b0, min(b1, b0 + widthM)]`, so a band can never be wider
than the movement it feeds. Imported data can carry wider bands, for example a 3.5 m lane
feeding a 3.0 m movement. A vehicle that ends up wider than its road anyway may make any lateral
move that reduces its overflow beyond the road edges (§2.4 candidates).

When the next route element after a link is a movement with band `fromLateral = [b0, b1]`
(effective band, above), a vehicle may continue only if its body lies inside the band. The
**band miss** of a body `[lo, hi] = [y − width/2, y + width/2]` is
`miss = max(0, b0 − lo) + max(0, hi − b1)`, and the body fits when `miss ≤ ε` (ε = `EPS` =
1e-9 m). The same miss drives the leader search obstacle (here), band seeking and band keeping
(§2.4), the deadlock-breaker trigger and choice (below), and insertion (§2.3).
- **No overhang (user decision, revision 2):** a body wider than its band never fits. A
  "cover the band" rule for wide vehicles was tried and rejected. The wide vehicles that
  needed it came from bus widths of up to 3.27 m in the data, which are now capped at 2.6 m as
  a data correction (VALIDATION.md §2). Every Silk Board link and band is at least 3.0 m wide.

Otherwise the end of the link counts as a **standing obstacle** in the leader search: a
candidate with rear end at offset `L_link − s_i` and speed 0. Vehicles that couldn't move
across in time stop at the end and keep trying to move laterally.

**Deadlock breaker (rerouting, M5 revision).** Vehicles that reach a link already in the wrong
band can stop side by side at the end, each needing the other's side, and never move. This swap
deadlock happens at diverges and was the first junction to lock in 8 of 10 Silk Board seeds.
- **Trigger:** a vehicle stopped (v < 0.1 m/s) within `s0 + 1 m` of the end of a link, because
  its body is outside the next movement's band, for **20 s** (`REROUTE_AFTER_S`, an
  assumption).
- **Action:** it switches to the movement from that link whose effective band its body
  overlaps best, and is rerouted from that movement's toLink to its destination (§2.1
  routing).
- **Diverted trips:** if the destination is unreachable from there, the vehicle is routed to
  the nearest reachable exit, and the trip counts as **diverted**.
- **Reporting:** `diagnostics()` reports `reroutes` and `diversions`. Real drivers resolve this
  situation the same way, by taking the branch they can reach and turning around later.
- **Limits (known):**
  - **Lateral moves are still needed:** the new band is enforced as before, so a vehicle that
    still fits no band after the switch, and cannot move laterally, stays stuck. This needs a
    class with lateral speed 0, which no calibrated class has. It is reported by the gridlock
    detector, not hidden.
  - **Vehicles added directly** (`addVehicle`, tests only) have no OD destination. Their
    reroute is never counted as a diversion.

### 2.3 Insertion from the entry queue
After generation, each origin in index order tries to insert the head of its queue onto the
origin link, repeating until an attempt fails.
- **Placement:** the vehicle's front goes at `s = length` (rear at 0).
- **Candidate lateral centres:**
  - **Strip mode:** `y_m = h + m·Δ` for m = 0, 1, … while `y_m + h ≤ W`, where
    `h = width/2 + c(v_ins)`, Δ is the strip width and W the link width.
  - **Lane mode:** the lane centres.
- **Gap per candidate:** the full §1.6 leader rule from the inserted position gives
  `gap = rear_L − length` and `v_ins = min(v0_eff, v_L)`. The rule includes route
  continuation, the lane-band rule and the look-ahead cap D evaluated with v = v0_eff. Using
  the full rule keeps insertion independent of how the road is split into segments. With no leader,
  `gap = ∞` and `v_ins = v0_eff`.
- **Feasible:** a candidate is feasible when `gap ≥ s0 + v_ins·T`, using the driver's
  parameters.
- **Band-centred candidate (revision 2, strip mode only):** in lane mode, vehicles enter at
  lane centres only, so this candidate does not apply there. If the origin link's next route element is a
  movement with band `[b0, b1]` and no candidate above fits it (band miss, §2.2), one more
  candidate is added: `y* = (b0 + b1)/2`, clamped to `[width/2, W − width/2]` when
  `width ≤ W`, otherwise `W/2`. Its body may then touch the road edges without clearance,
  which band-seeking moves already allow (§2.4). Before this rule, a 2.89 m bus whose entry
  link fed a 3 m band had no candidate inside the band, because every grid candidate keeps
  edge clearance. It never entered, and its origin's queue grew without limit at any demand
  (Silk Board, seeds 46 and 47).
- **Choice:** if the origin link's next route element is a movement with band `[b0, b1]`, and
  at least one candidate's body fits the band (band miss ≤ ε, §2.2), only those in-band
  candidates are considered.
  - **Status:** vehicles enter already sorted, so the model does **not** simulate merging at
    lane drops. This is a documented simplification (M2, user decision).
  - **What was tried:** a band zone, where band rules apply only within 150 m of the node, made
    vehicles use the dropped lane. Without a dedicated zipper or forced-merge model, saturated
    throughput then collapsed (lane mode about 2,650–3,050 veh/h, strip mode 0–2,300, against
    about 5,500–6,200 on the plain road). Cooperative yielding fixed swap deadlocks but turned
    merges into stop-and-go. A merge model is future work. If none of them is feasible,
  the vehicle waits in the queue. Drivers enter on the side they need, which prevents swap
  deadlocks at diverges. When no candidate fits the band at all (the vehicle is wider than
  the band), every candidate is considered. Within that set, the candidate with the largest gap wins. Ties go to
  the one closest to the preferred centre `y_pref = h + u_lat·(W − 2h)`, then to the smaller
  y.
- **Initial state:** the vehicle starts at `v = v_ins`, `targetY = y`.
- **No feasible candidate:** the vehicle stays in the queue, which blocks the queue behind it
  (FIFO). Time spent in the queue counts toward delay.

### 2.4 Lateral decisions: generalised MOBIL
Lateral decisions use the same snapshot as §1.7 step 1, and take the accelerations `a_x`
computed in that step as the "current" values.

**Who decides:** a vehicle decides only when it is on a **link** (not a movement path) and is
at its target (`y = targetY`).

**Candidate targets:**
- **Strip mode:** `y' = y + j·Δ` for `j ∈ {−J, …, J} \ {0}`, with
  `J = max(1, floor(maxLatSpeed · τ / Δ))` and τ = 1 s. A candidate must keep body plus
  clearance inside the road: `y' − h ≥ 0` and `y' + h ≤ W`.
- **Lane mode:** `y' = y ± laneWidth`, inside the road.

**Clearance used by decisions:** candidate, target and swept spans are computed with
`c(v_now)`, which is the clearance that becomes frozen (`c_occ`) when the move is committed. The
span checked for safety is therefore exactly the span occupied afterwards. With c1 > 0 a stale
`c_occ` could otherwise widen a committed span into a neighbour (found on Silk Board).

**Standing obstacles:** when the new leader at y′ is a standing obstacle (a link end under the
lane-band rule, or a held stop line) rather than a vehicle, the new-leader gap floor and the
self-safety criterion do not apply. The obstacle does not move, so edging sideways in front of
it at standstill is safe. Without this, a vehicle that reached the end of an acceleration lane
could never make the partial lateral moves it needs.

**Unchanged follower:** when the new follower N in the target strips is the vehicle that already
follows the mover in its current span (N = O), the move leaves N's leader and gap unchanged. N's
gap floor and B_SAFE checks are skipped, and both N's and O's politeness terms are 0. Before
this rule, a car stopped at the end of an acceleration lane with a motorcycle 0.05 m behind it,
partly overlapping both spans, could never edge into the main band, and the merge locked
(on-ramp preset, 1 seed in 10 even at 1,200 + 300 veh/h). In lane mode, spans of adjacent
lanes never overlap, so N ≠ O and classic MOBIL is unchanged.

**Band-seeking moves:** a candidate that reduces the distance to the next movement's band needs
only the body inside the road (`y′ ± width/2` within `[0, W]`), not the edge clearance. Otherwise
a wide vehicle whose next movement is narrow can face a contradiction: edge clearance forbids
every in-band position, and it waits forever. Silk Board has a 2.69 m bus, a 3.5 m link and a
3.0 m movement. Other candidates keep the full edge-clearance rule.

**Band-centred move (revision 2, strip mode only):** candidates are offsets `y + j·Δ` from the
current position, so a band only slightly wider than the body can leave no grid candidate that
fits it.
- **When it applies:** the vehicle's body misses its next movement's band (band miss > ε,
  §2.2), and no grid candidate within reach (`|j| ≤ J`) has band miss ≤ ε.
- **Extra candidate:** the band-centred position
  `y* = clamp((b0 + b1)/2, width/2, W − width/2)` (`W/2` when width > W), when
  `|y* − y| ≤ J·Δ`.
- **Rules:** it is a band-seeking move (body inside the road; every safety check applies) and
  is evaluated like any other candidate.
- **Why:** on Silk Board a 2.98 m bus stood at y = 1.61 before a 3.0 m band [0, 3]. The only
  centres that fit, 1.49–1.51, were off its 0.25 m grid. The grid steps either overflowed the
  road or missed the band. It waited for over 1,300 s, and 80 vehicles on the minor approach
  that yields to its movement piled up behind it (seed 47).

**Band keeping:** a candidate that would take the body out of the next movement's band when it
is currently inside (`dist(y) = 0 < dist(y′)`) is not a candidate. Discretionary overtaking
never leaves the side a vehicle needs.

**Followers across segment starts:** when i's rear reaches back past the start of its link,
vehicles on the link's predecessor segments (the movements leading into it) whose fronts lie
within `length_i + maxLength` of the segment start also count.
- **Position:** their front is taken as `s_j − length(pred)`, which is negative in i's
  coordinates.
- **Lateral span:** their y and targetY are mapped into i's link with the movement's
  toLateral band, and the span is computed in i's layout.
- **Use:** they are candidates for N and O, after own-link candidates, and they are included
  in the side-clash check.

**Quantities for each candidate**, with `span_t` the occupancy at y' (§1.5) and
`span_s = sweptStrips(y, y')`:
- **ã_c:** i's IDM acceleration at its new leader. The new leader comes from the §1.6 rule over
  vehicles overlapping `span_t`, ahead of i, continuing along the route, with the lane-band
  rule applied at y'.
- **N (new follower):** among vehicles on i's link overlapping `span_t` and behind i
  (`front_j < front_i`, or equal fronts and `id_j < id_i`), the one with the largest front
  (ties go to the larger id).
  - **Gap:** `g_N = (front_i − length_i) − front_N`.
  - **Accelerations:** `ã_N = IDM_N(v_N, g_N, v_N − v_i)`; `a_N` is N's current acceleration.
- **O (old follower):** chosen the same way, over i's current span. Its acceleration without
  i, `ã_O`, comes from the §1.6 leader rule over O's span with i excluded. `a_O` is O's
  current acceleration.

**Safety (all required):**
- **kinematic gap floor** (M2 revision): the new-leader gap is
  `≥ v_i·dt + ½·a_i·dt² + 0.1 m`, and the new-follower gap (if N exists) is
  `≥ v_N·dt + ½·a_N·dt² + 0.1 m`, and both are also `≥ ½·s0` of the vehicle behind (an
  assumption: the tightest gap accepted in a standstill zipper merge).
  - **Why:** the vehicle behind must not be able to close the gap within the same synchronous
    step, before it can see the move.
  - **Why not s0:** an earlier floor of s0 blocked zipper merges at standstill, where gaps
    are below s0.
  - **Acceleration term:** a is the IDM acceleration from step 1, taken as 0 when negative.
- the new-leader gap is > 0, and the mover's own acceleration there satisfies
  `ã_c ≥ −B_SAFE` (self-safety; without it a fast vehicle can move in close behind a slower
  one that it cannot avoid even at B_MAX);
- if N exists, `g_N > 0` and `ã_N ≥ −B_SAFE`, with `B_SAFE = 4 m/s²`;
- no vehicle that overlaps `span_s` overlaps i longitudinally, meaning its interval
  `[front − length, front]` intersects i's interval.

**Incentive:**
`Δ = (ã_c − a_c) + p·((ã_N − a_N) + (ã_O − a_O)) + bias(y, y')`. Terms for a missing N or O
are 0. p is the class `politeness`.

**Route bias:**
- **Band:** if the next route element is a movement with band `[b0, b1]`, let
  `dist(y) = max(0, b0 − (y − width/2)) + max(0, (y + width/2) − b1)`. Otherwise bias = 0.
- **Bias:** `bias = β·(dist(y) − dist(y'))`, with `β = min(1, 200 / max(d, 1))` m/s² per m,
  where d is the distance from i's front to the link end. (It was `0.5·min(1, 50/d)` until
  the diverge test showed vehicles overtaking out of their required band 500 m before a
  split, then deadlocking side by side at the split. With the stronger bias, leaving the band
  at 500 m costs about 0.4 m/s² per metre.)

**Decision:**
- A candidate qualifies if it is safe and `Δ > Δa_th`, the class `thresholdMps2`. The threshold
  is waived (taken as 0) when `dist(y) > 0` and `d < 30 m`.
- The chosen target is the qualifying candidate with the largest Δ. Ties go to the smaller |j|,
  then to the smaller y'.

**Committing (deterministic):**
- **Order:** within each link, decisions are committed in order of `(front desc, id asc)`.
- **Re-check:** a decision is dropped if its swept span overlaps the swept span of a
  decision already committed this step (vehicle j), and either:
  - j's longitudinal interval, widened by `s0_i` on both ends, intersects i's interval; or
  - the pair fails the safety criteria above. If j is ahead, i needs a gap > 0, at least
    i's kinematic gap floor, and `IDM_i(gap, v_j) ≥ −B_SAFE`. If j is behind, j needs a gap
    > 0, at least j's kinematic gap floor, and `IDM_j(gap, v_i) ≥ −B_SAFE`.
- **Effect:** committing sets `targetY = y'`.

**Lateral motion** (applied after the longitudinal integration):
- **Each step:** `y ← y + sign(targetY − y) · min(|targetY − y|, v_lat · dt)`.
- **Lateral speed:**
  - **Strip mode:** `v_lat = maxLatSpeed · min(1, 0.25 + v/4)`, so 25% of full lateral speed
    at a standstill and full speed from 3 m/s.
  - **Lane mode:** `v_lat = laneWidth / 3 s`.
- **Occupancy while moving:** a vehicle with `y ≠ targetY` occupies `sweptStrips(y, targetY)`;
  in lane mode, both lanes.
- **Clearance edge condition:** in strip mode, clearance is applied against the road edges too.

**Status of the constants:** B_SAFE, τ, β, the 30 m waiver, the lateral-speed shape and the 3 s
lane change are engineering assumptions (ADR-004), not calibrated values.

**Lane mode reduces to MOBIL:** with no route bias, candidates are the adjacent lanes, spans
are single lanes, and Δ is the standard MOBIL incentive with politeness p and threshold Δa_th
(Kesting, Treiber & Helbing 2007).

### 2.5 Update order (replaces §1.7's list)
1. From the snapshot, compute every vehicle's leader, gap and IDM acceleration.
2. From the same snapshot, compute lateral decisions (§2.4).
3. Commit the decisions (§2.4).
4. Integrate longitudinal motion with `ballistic`.
5. Apply lateral motion, then recompute occupancy.
6. Transfer across segment ends, and remove vehicles that finished their route.
7. Generate arrivals (§2.1) and insert from entry queues (§2.3).
8. Set `t ← (step + 1)·dt` and `step ← step + 1`.

### 2.6 Corridor generator (`generator: 'corridor'`)
- **Geometry:** the corridor runs along +x. The left edge, which is the kerb, stays straight
  at world y = 0, so a carriageway of width W has its centreline at y = −W/2.
- **`change.kind = 'none'`:** one link `main` from (0, −W/2) to (L, −W/2), with zones `in` and
  `out` on `main`.
- **`width` or `laneDrop`:**
  - **Upstream:** link `up` on x ∈ [0, atM], width W, `lanes`.
  - **Taper:** movement `taper` at node `n1` with its path on x ∈ [atM, atM + taperM], width
    W2, and `fromLateral = toLateral = [0, min(W, W2)]`.
  - **Downstream:** link `down` on x ∈ [atM + taperM, L], width W2, `lanes2`. Its centreline
    is at y = −W2/2, and so is the taper's.
  - **Lane drop:** W2 = W·(lanes − dropLanes)/lanes and lanes2 = lanes − dropLanes. Lanes drop
    on the right (median side).
  - **Width change:** W2 = `toWidthM` and lanes2 = `toLanes`.
  - **Zones:** `in` on `up`, `out` on `down`.
- **Schema rule:** `atM + taperM < lengthM`, so the downstream link is longer than 0.

### 2.7 Metrics
- **`counters()`:** `generated` = exited + onNetwork + entryQueue, exactly, at every step
  (T11). Initial vehicles count as generated.
- **`linkStats()`:** cumulative per segment since t = 0: `entered`, `exited`,
  `vehicleSeconds` (Σ over steps of occupants·dt, counted by front position after the step),
  `travelTimeSum` and `travelTimeCount` (time between a vehicle's front entering and leaving,
  for vehicles that did both).
- **`trips()`:** completed trips `{ id, origin, destination, classId, tGen, tInsert, tExit, freeFlowS }`.
  freeFlowS is the route length divided by `min(v0_driver, speedLimit)`, summed per segment.
  Delay = `tExit − tGen − freeFlowS`.
- **`generatedLog()`:** for every generated vehicle:
  `{ id, origin, destination, classId, tGen, length, width, v0, T, s0, a, b, freeFlowS }`.
  freeFlowS is computed as in `trips()`.
- **`series()`:** rows per 60 s window `{ t0, t1, generated, inserted, exited, exitFlowVph, meanSpeedMps, densityPerKm, entryQueue, onNetwork }`.
  - meanSpeedMps is the time-average over the window's steps of the space-mean speed.
  - densityPerKm is the time-average of onNetwork ÷ total link length in km.
  - entryQueue and onNetwork are end-of-window values.
- **`addVehicle(spec)`:** construction API for tests and scenarios.
  - **Signature:** `addVehicle({ classId, link, s, y, v }): number` places a vehicle with its
    class's base parameters (no driver draws) and `targetY = y`.
  - **Ids and routes:** ids are `0x50000000 + k`. The route comes from the default route rule
    of §2.8. `link` may also be a movement id, which places the vehicle on that movement path.
- **`VehicleView`** gains `targetY` and `freeFlowTravelledS` (§5.2).
- **Accounting identity:** summed over all generated vehicles, delay so far equals vehicle-seconds
  spent in the network and the entry queues minus the free-flow time for the distance actually
  travelled, up to dt-level discretisation. On a movement path, `link` is the movement id.

### 2.8 Clarifications (binding)
- **Default route (initial and added vehicles):** follow the first outgoing movement of each
  segment until a dead end (the vehicle exits there) or a cycle back to the start (a looping
  route, as on the ring).
- **Movement speed limit:** `min(speedLimit(fromLink), speedLimit(toLink))`. It is used in
  `v0_eff` and in route cost.
- **Zone ids:** `origin` and `destination` in `trips()` and `generatedLog()` are zone-id
  strings. `generatedLog()` lists only demand-generated vehicles, not initial or added ones;
  `counters().generated` counts all of them.
- **`linkStats()`:** returns `Record<segmentId, { entered, exited, vehicleSeconds, travelTimeSum, travelTimeCount }>`
  for every segment, including movements.
- **Lateral speed:** `v_lat` uses the snapshot speed, before integration.
- **`series()`:** has rows only for completed windows. Samples are taken after every step whose
  end time is in `(t0, t1]`. `meanSpeedMps` is 0 on an empty network.
- **Ordering:** within a segment, vehicles are ordered by `(s, id)`. "Intersects" in the
  longitudinal-clash rule means open-interval overlap. In lane mode, "inside the road" means
  `0 < y′ < W`.
- **Known limitation (strip MOBIL):** a vehicle behind a wide, slow leader that needs more than
  J strips to escape sees no candidate with a different leader, so it stays until the
  leader's speed changes or route bias applies. Candidates are not searched beyond J strips
  per decision.

## 3. Junctions (M3)

### 3.1 Conflict areas (geometry): `network/conflicts.ts`
```ts
export function computeConflicts(net: Network): Map<string, Conflict[]>   // movement id → conflicts
```
- **Which pairs:** conflicts are computed only between movements at the **same node**, so
  separate layers never conflict (T17). Movements that already carry `conflicts` keep them.
- **Ribbons:** for movement m, `ribbon(m)` is the region within `widthM/2` of its centreline
  path.
- **Interval on m:** the conflict interval on m against m′ is the set of arc lengths s on m
  whose cross-section segment (perpendicular, length `widthM`, centred on the path) intersects
  `ribbon(m′)`. It is reported as `[min s, max s]`, and `other` is defined symmetrically.
- **Sampling:** in practice, sample s every 0.25 m and lateral offsets at 9 points across
  `[−w/2, w/2]`. Test points are expanded by the sample spacing so the result over-approximates.
- **Analytic check (T22):** two straight strips of widths w₁ and w₂ crossing at angle θ give an
  interval on path 1 of length `w₂/sin θ + w₁·|cot θ|`, centred on the crossing point of the
  centrelines, and the symmetric result on path 2. With θ = 90° this reduces to w₂ and w₁.
  Disjoint ribbons give no conflict.
- **Type:**
  - `merging` if `toLink` is equal;
  - `diverging` if `fromLink` is equal (and toLink differs);
  - otherwise `crossing`.
- **Tolerance for T22:** the test tolerance is the sampling resolution (0.25 m plus
  w·|cot θ|/8 from the 9-point cross-section).

### 3.2 Signals: `junction/signals.ts`
```ts
export const SIG = { RED: 0, AMBER: 1, GREEN: 2, PERMISSIVE: 3, NONE: 255 } as const
export function cycleLength(plan: SignalPlan): number   // Σ (greenS + amberS + allRedS)
export function signalState(plan: SignalPlan, movementId: string, t: number): 0 | 1 | 2 | 3
```
- **Position in the cycle:** `τ = (t − offsetS) mod C`, taken in `[0, C)`. Phase i starts at
  `start_i = Σ_{j<i}(green_j + amber + allRed)`.
- **During `[start_i, start_i + green_i)`:** movements in `protected_i` are GREEN and those in
  `permissive_i` are PERMISSIVE.
- **During the inter-green after phase i:**
  - **Amber window** `[start_i + green_i, + amber)`: movements that were protected **or
    permissive** in phase i are AMBER, unless they are also protected or permissive in phase
    i+1 (cyclically), in which case they keep their phase-i state. Permissive-only movements
    get an amber too: going straight to red would be unsafe.
  - **All-red window** `[…, + allRed)`: movements that were protected or permissive in phase
    i are RED, unless they are protected or permissive in phase i+1, in which case they keep
    their phase-i state.
- **Otherwise RED.** A movement listed as protected in one phase and permissive in another
  takes the state of the phase that is running.
- **Overrides:** `scenario.signalOverrides` replace the plans for their nodes.

### 3.3 Gap acceptance: `junction/gap.ts`
```ts
export function acceptGap(timeToNextPriority: number, sinceLastEntry: number, tc: number, tf: number): boolean
// = timeToNextPriority >= tc && sinceLastEntry >= tf
export function saturatedDischarge(majorArrivals: readonly number[], tc: number, tf: number, horizon: number): number[]
```
- **Discharge model:** `saturatedDischarge` returns the entry times of an always-present minor
  queue. Each entry happens at the earliest instant ≥ the previous entry + tf (or ≥ 0 for the
  first) at which the time to the next major arrival is ≥ tc. Entries may happen exactly at
  major arrival instants, after the major vehicle has passed. Only entries at
  `t < horizon` are returned (the horizon is exclusive).
- **Theory (T14):** with Poisson major arrivals at rate q, the long-run entry rate is
  **Harders' capacity** `q·e^{−q·tc} / (1 − e^{−q·tf})` (Harders 1968; the stepwise gap-acceptance capacity used for HCM two-way-stop control).
- **Driver parameters:** `tc` and `tf` per driver are `criticalS · (1 + spread·u₁)` and
  `followUpS · (1 + spread·u₂)` from substream `(gap, id)`. A third draw
  `u₃ < boxCompliance` decides whether this driver obeys "don't block the box".

### 3.4 Junction behaviour in the simulation
A vehicle whose next route element is a movement m, at node X, has a stop line at the end of
its current link. Its leader search (§1.6) also sees the **junction obstacles** below; each
one is a standing obstacle with rear at the stop line, or at the conflict entry, and speed 0.

1. **Signal:** if m is signal-controlled:
   - **RED:** the stop line is an obstacle.
   - **AMBER:** the stop line is an obstacle when the distance to it `d ≥ v²/(2b)`.
   - **GREEN, PERMISSIVE or committed:** no signal obstacle.
2. **Priority and gap acceptance** at a stop line, for each crossing or merging conflict c of m
   against m′ where m must yield:
   - **When m yields:** m′ is GREEN (protected) while m is PERMISSIVE; or at a priority node,
     m is `minor` and m′ is `major`; or m′ is `free` and m is not.
   - **Higher-priority vehicles:** vehicles on m′, or on m′'s fromLink within 150 m of its stop
     line and routed through m′, whose rear has not passed the end of the conflict interval on
     m′.
   - **Estimated arrival:** `t_j = d_j / max(v_j, 0.5)`, where d_j is the distance from j's front
     to the start of the conflict interval on m′ (0 if already inside).
   - **Rule:** let `timeToNext = min_j t_j` (∞ if none) and `sinceLastEntry` = now minus the last
     time a vehicle entered m from this link (∞ if none). The vehicle may cross its stop line
     only if `acceptGap(timeToNext, sinceLastEntry, tc, tf)` holds for every yielding
     conflict. Otherwise the stop line is an obstacle.
   - **Timing:** the decision is evaluated each step while `d ≤ max(v²/(2b), 2 m) + v·dt`.
3. **Commitment:** a vehicle is committed once its front crosses the stop line. A committed
   vehicle ignores signals and gap acceptance for that movement. It still respects occupied
   conflict areas (rule 4) and leaders.
4. **Occupied conflict area (collision avoidance, every movement):**
   - **Crossing conflict:** for a crossing conflict c ahead of vehicle i on m, if some vehicle
     j ≠ i has its body intersecting c's interval on m′, then c's entry on m is an obstacle for
     i. The exception: j is itself waiting before c on m′ because of a conflict with i's
     movement, which avoids mutual blocking.
   - **Merging and diverging conflicts:** vehicles on m′ inside the conflict interval are
     projected onto m as leader candidates. Merging uses the distance remaining to the end of
     each path; diverging uses the distance from the start. The overlap test uses the
     movements' lateral bands.
   - **Approaching vehicles at a merge:** vehicles still on m′'s approach link (within 60 m of
     its end) are projected too, but only if they will actually enter. That means m′ is not
     red or amber, m′ does not yield to m, and the vehicle is moving at more than 0.5 m/s.
     Otherwise a vehicle waiting at a red light on another arm would block m (found in the
     4-arm preset).
5. **Don't block the box** (all movement controls, including `free`, at **junction nodes**:
   nodes with at least two movements, the same definition as item 6; a ring's self-loop node
   or a corridor taper is not a junction). `boxCompliance`
   defaults to **1.0**. Lower values are an editable **assumption**, since no source is
   available for Indian junctions: a vehicle may cross its stop line into m only if the space beyond
   the box is `≥ length_i + s0_i`.
   - **Measuring the space:** along the vehicle's route from the start of m's toLink up to the
     nearest **standing-queue** vehicle's rear (speed < 2 m/s), continuing across segments while
     none is found.
   - **Why only slow vehicles:** moving traffic beyond the box is handled by car-following.
     Counting it as blocking throttled free-flowing merges, because each vehicle waited until
     its predecessor was length + s0 past the stop line.
   - **Why not the toLink alone:** short exit links are common in OSM networks (Silk Board has
     a 7 m one). Measuring space on the toLink alone could never be satisfied there and
     blocked the junction permanently. This check is skipped for drivers whose `u₃ ≥ boxCompliance`.
6. **Gridlock detector, per junction:** a **junction** is a node with at least two
   movements. Its **region** is the vehicles on its movements plus the vehicles whose fronts
   are within 50 m of the end of any of its incoming links.
   - **Locked:** a junction is locked when, for ≥ 300 s of simulated time, its region is
     non-empty, no vehicle in the region has speed > 0.1 m/s, and no vehicle entered or left
     any of its movements.
   - **Whole network:** separately, the network as a whole counts as locked when, for ≥ 300 s,
     no vehicle on the network has speed > 0.1 m/s, nothing was inserted or exited, and
     `onNetwork > 0`.
   - **Result:** `sim.gridlock()` returns
     `{ detected, sinceS, junctions: [{ node, sinceS }] }`, or null when nothing is locked.
     - `detected` is true when any junction is locked or the whole network is.
     - `sinceS` is the earliest time a stalled condition began.
     - `junctions` lists the locked nodes, each with the time its stall began.
   - **Why per junction:** one junction can lock while the rest of the network keeps moving
     (Silk Board).
   - **Other rules:** the 300 s window is longer than any signal cycle. Vehicles are never
     teleported. `series()` rows carry the count of locked junctions.

### 3.5 Junction generator (`generator: 'junction'`), left-hand traffic
- **Arms:** arm k has outward unit vector `e_k = (cos θ_k, sin θ_k)` (θ in degrees,
  counter-clockwise from east, via dcos/dsin) and left normal `n_k = (−sin θ_k, cos θ_k)`.
- **Box radius:** `r0 = 0.5·max_k(inWidthM_k + outWidthM_k) + 4 m`.
- **Outbound link `arm{k}_out`:** travels outward from r0 to `r0 + lengthM` along e_k. Its
  centreline is offset by `+n_k·outWidthM/2`, because traffic keeps left.
- **Inbound link `arm{k}_in`:** travels inward from `r0 + lengthM` to r0. Its centreline is
  offset by `−n_k·inWidthM/2`.
- **Movements `m{i}_{k}`:** one for every inbound i to every outbound k with k ≠ i (no
  U-turns).
  - **Path:** a cubic Bézier from the inbound end P0 (heading −e_i) to the outbound start P3
    (heading e_k), with `P1 = P0 − e_i·d` and `P2 = P3 − e_k·d`, `d = 0.4·|P3 − P0|`, sampled
    at 17 points.
  - **Turn type:** the turning angle δ from heading −e_i to e_k, normalised to (−180°, 180°]:
    |δ| < 30° is through, δ > 0 is a left turn (towards the kerb in LHT), δ < 0 a right turn.
  - **Bands:** with `lw = inWidthM/inLanes`, lanes are numbered from the left (kerb), from 0
    to n−1.
    - **One lane:** every movement uses [0, inWidthM].
    - **Two or more lanes:** left turns use lane 0, right turns lane n−1, and through
      movements lanes 0…n−1. `fromLateral` is the union of the allowed lanes.
  - **Width and landing band:** the movement width is `w = min(fromLateral width, outWidthM)`.
    `toLateral = [t0, t0 + w]`, where t0 is 0 for left turns, `outWidthM − w` for right turns,
    and `clamp(fromLateral[0], 0, outWidthM − w)` for through movements.
- **Control:**
  - **signal:** every movement is `signal`. The default plan is **split phasing**: phase k
    makes all of inbound arm k's movements protected, with greenS = 25, amber 3 and all-red 2.
  - **priority:** movements between the two `majorArms` (both directions), plus left turns
    from major arms, are `major`; all others are `minor`. The node kind is `priority`.
- **Zones:** `arm{k}_in` on the arm's entry link and `arm{k}_out` on its exit link. Zone IDs
  are the same whether the flyover is on or off.
- **Flyover (enabled, arms A and B):** for each direction X→Y in {A→B, B→A}:
  - **Approach split:** arm X's inbound is split at distance `r0 + rampLengthM + 20 m` from
    the centre into:
    - `arm{X}_in` (far part, from the arm end to the split node `dX`, where the zone stays);
    - at-grade `arm{X}_in_near` (width `landingWidthM`, from dX to r0);
    - `fly{X}{Y}_up` (layer 1, width `rampWidthM`, z 0 → heightM, from dX towards the
      centre, ending at distance r0 + 20 m, so its length is exactly `rampLengthM`);
    - `fly{X}{Y}_deck` (layer 1, width `deckWidthM`, z = heightM, straight across the box
      from r0 + 20 m on arm X to r0 + 20 m on arm Y);
    - `fly{X}{Y}_down` (layer 1, width `rampWidthM`, z heightM → 0, from r0 + 20 m on arm Y
      to merge node `mY` at distance `r0 + rampLengthM + 20 m`, so its length is
      `rampLengthM`).
  - **Exit split:** arm Y's outbound is split into `arm{Y}_out_near` (width `landingWidthM`,
    from r0 to mY) and `arm{Y}_out` (far part, where the zone stays).
  - **Nodes:** the split and merge nodes are at layer 0. The deck nodes are at layer 1.
  - **Movements:** `free` movements join up→deck and deck→down. At `dX`, `arm{X}_in` diverges
    to `arm{X}_in_near` and `fly{X}{Y}_up` (`free`). At `mY`, `fly{X}{Y}_down` (major) and
    `arm{Y}_out_near` (minor) merge into `arm{Y}_out`.
  - **Lateral placement (LHT):** the elevated carriageways run along the road axis in the
    median. The at-grade near links are offset outward by `deckWidthM`.
  - **Bands at the split:** `fly{X}{Y}_up` takes the right part of `arm{X}_in`
    (`[inW − rampW, inW]`) and `arm{X}_in_near` takes the left part (`[0, landingW]`).
  - **Grade (T23):** ramp grade = `heightM / rampLengthM`.
  - **Routing:** through traffic X→Y prefers the deck because its free-flow cost is lower
    (§2.1). Turning traffic uses the at-grade junction.

### 3.6 Merge generator (`generator: 'merge'`), on-ramp joining from the kerb side
- **Links:**
  - `main_up` (mainWidthM, mainLanes) runs along +x to node `n1`.
  - `ramp` (rampWidthM, one lane) arrives at `n1` at angle `angleDeg` from the kerb side.
  - `accel` (width mainW + rampW, length taperM) is the acceleration lane.
  - `main_down` (mainWidthM) follows it.
- **Movements at n1:** `main_up→accel` with toLateral `[rampW, rampW + mainW]`, and
  `ramp→accel` with toLateral `[0, rampW]`. Both are `free`; their bands are disjoint, so
  there is no crossing conflict.
- **End of the acceleration lane:** movement `accel→main_down` with fromLateral
  `[rampW, rampW + mainW]` and toLateral `[0, mainW]`. Ramp vehicles must move across into the
  main band before the end of `accel` (lane-band rule §2.2 plus route bias §2.4). Merging
  therefore emerges from the lateral model.
- **Zones:** `main_in` on main_up, `ramp_in` on ramp, `main_out` on main_down.

## 5. Experiments (M4)

### 5.1 Statistics: `stats/tdist.ts`, `stats/ci.ts`
```ts
export function tQuantile(p: number, df: number): number            // Student-t inverse CDF
export function meanCI(xs: readonly number[], level?: number): { mean: number; half: number; lo: number; hi: number; n: number; sd: number }
export function pairedCI(a: readonly number[], b: readonly number[], level?: number): { mean: number; half: number; lo: number; hi: number; n: number; sd: number }   // CI of b − a
```
- **`tQuantile`:** accurate to 1e-6 for df ≥ 1 and p in (0.5, 0.9999). It is computed by
  bisection on the regularized incomplete beta function (continued fraction), so no lookup
  table is needed. The level defaults to 0.95.
- **`meanCI`:** `half = t_{(1+level)/2, n−1} · sd/√n`, with sd the sample standard deviation
  (n − 1). For n < 2 the half-width is Infinity.
- **`pairedCI`:** `meanCI` of the per-seed differences `b_i − a_i`. Seeds are paired: replicate
  i of both variants uses the same seed, so arrivals and vehicles are identical (common random
  numbers, §1.2, T21).

### 5.2 Replicate metrics: `stats/experiment.ts`
```ts
export interface ReplicateResult { seed: number; metrics: Record<MetricId, number> }
export type MetricId = 'meanDelayS' | 'meanDelayCompletedS' | 'gridlocked' | 'queueGrowing' | 'meanTravelTimeS' | 'throughputVph' | 'meanSpeedKmh' | 'maxEntryQueue' | 'completedTrips' | 'incompleteTrips' | 'divertedTrips' | 'lockedJunctions' | 'guardPer10k' | 'guardPer1000VehKm'
export function runReplicate(input: SimInput, seed: number): ReplicateResult
export function summarize(results: ReplicateResult[]): Record<MetricId, ReturnType<typeof meanCI>>
export function compare(base: ReplicateResult[], variant: ReplicateResult[]): Record<MetricId, ReturnType<typeof pairedCI>>
```
- **Run:** `runReplicate` runs `scenario.durationS` with the given seed.
- **Measurement window:** `[warmupS, durationS]`. Trips count when their **generation time** is
  in the window.
- **Per-trip metrics** (trips generated in the window):
  - **`meanDelayS`:** the mean over **all** of them, so a gridlocked run cannot look fast.
    - **Completed trips:** delay is `tExit − tGen − freeFlowS`.
    - **Unfinished trips** (still in an entry queue or on the network at `durationS`): delay so
      far is `durationS − tGen − freeFlowTravelledS`.
      - `freeFlowTravelledS` is the free-flow time for the distance the vehicle's front has
        **actually travelled** since insertion, at `min(v0, speed limit)` per segment, added up
        step by step.
      - A vehicle still in the entry queue has travelled 0 m, so its delay so far is the full
        `durationS − tGen`.
      - Subtracting the whole route's free-flow time instead would credit time never driven and
        make oversaturated runs look better (user correction).
    - **Both** include entry-queue time.
  - **`meanDelayCompletedS`:** the same mean over completed trips only, the old definition, kept
    for reference.
  - **`meanTravelTimeS`:** `tExit − tGen` over completed trips.
- **Window metrics:**
  - `throughputVph`: exits in the window × 3600 / window length.
  - `meanSpeedKmh`: the time-average over the window's series rows.
  - `maxEntryQueue`: the maximum `entryQueue` over those rows.
- **Incomplete trips:** generated in the window but not exited by `durationS`. They are
  reported as a count, never dropped silently.
- **Gridlock and guard:** `lockedJunctions` comes from `gridlock()` at the end, and
  `gridlocked` is 1 if `lockedJunctions > 0`, otherwise 0;
  `guardPer10k` is guard activations per 10k vehicle-steps over the **whole run**. Vehicle-steps
  are the sum over steps of the vehicles on the network **after** each step.
- **Queue still growing (`queueGrowing`, revision 2):** 1 if the entry queue is still growing
  at the end of the run, otherwise 0.
  - **Queue size:** let `Q(t)` be `counters().entryQueue` (all origins) at time t.
  - **Midpoint:** `m = warmupS + (durationS − warmupS)/2`, rounded down to a whole step.
  - **Threshold:** `λ` is the total OD demand in veh/s (the sum of `rateVph` / 3600).
  - **Rule:** `queueGrowing = 1` iff `Q(durationS) − Q(m) > max(10, 60·λ)`, that is, the queue
    grew by more than one minute of total demand (and at least 10 vehicles) over the second half
    of the window.
  - **Provenance:** the threshold is an **assumption**. It ignores fluctuations of a stable
    queue and flags a queue that is fed faster than it drains. A queue that settles at a high
    level is reported by `maxEntryQueue` and is not flagged.
- **Diverted trips (`divertedTrips`):** the number of diversions (§2.2) that happen inside the
  window, i.e. `diagnostics().diversions` at `durationS` minus its value at `warmupS`.
- **Guard per distance (`guardPer1000VehKm`):** guard activations over the **whole run** ×
  1000 / vehicle-km over the whole run.
  - **Vehicle-km:** `diagnostics().vehicleKm` is the sum over steps and vehicles of the front's
    displacement `ds` (step 5, the same displacement that moves the vehicle), ÷ 1000.
  - **Why this unit:** `guardPer10k` divides by vehicle-steps, and in a gridlocked run most
    vehicle-steps are spent standing still, where the guard cannot act. That dilutes the rate.
    Distance driven measures the exposure the guard acts on.
- **Time step:** `dtS` is one of 0.1, 0.2 or 0.25 s (default 0.2), enforced by the scenario
  schema. 0.5 s was removed because it breaks the tests' dt-error assumptions (revision 4).
- **Windows:** "in the window" is inclusive. Series rows count when `t0 ≥ warmupS` and
  `t1 ≤ durationS`. `SimInput` is `{ scenario, classes, network? }`, the same as for
  `createSim`.
- **Empty means:** a mean over zero trips is NaN, and the UI shows "—".

### 5.3 Retimed flyover variant (Webster): `junction/retime.ts`
```ts
export function retimeWebster(plan: SignalPlan, criticalFlowRatio: Record<string /*movement*/, number>): SignalPlan
export function criticalFlowRatios(input: SimInput): Record<string /*movement id*/, number>   // q_m / s_m for every movement
export function retimedFlyoverScenario(input: SimInput): ScenarioInput  // flyover scenario with its junction plan(s) retimed
```
- **Inputs:** the cycle length C and the lost time per phase (`amberS + allRedS`) are kept.
- **Phase flow ratio:** `y_p = max` over the phase's movements (protected and permissive) of
  `criticalFlowRatio[m]`. A movement missing from the map counts as 0.
- **Available green:** `G = C − Σ_p (amberS + allRedS)`.
- **Allocation:** each phase gets `g_p = max(5 s, G · y_p / Σ y)`, then scaled so that
  `Σ g_p = G` while keeping the 5 s minima. If `Σ y = 0`, green is split equally.
- **Critical flow ratio of a movement:** `q_m / s_m`. Here `q_m` is the OD demand routed
  through m, from the routes (§2.1), and `s_m = 1800 veh/h per 3.5 m of movement width` (HCM
  base, an assumption).
- **`criticalFlowRatios(input)`:** routes every OD row with the §2.1 rule on the input's network
  (generated or supplied) and sums the rates of the rows whose route uses movement m. It returns
  `q_m / s_m` for every movement, 0 when unused.
- **`retimedFlyoverScenario(input)`:** returns the input scenario with `signalOverrides` holding
  `retimeWebster(plan, criticalFlowRatios(input))` for every signal plan of its network.
- **Use:** "Flyover, retimed" = the flyover network with its junction plan retimed using the
  demand that still uses the at-grade box. Through traffic on the deck no longer counts, so the
  flyover arms lose the green they no longer need.

### 5.3b Experiments view: run flags and rows (revision 2)
- **Gridlocked runs:** a row `data-testid="gridlocked-runs"` showing "k / n" per variant (k runs
  with `gridlocked = 1`). A `role="status"` warning mentioning gridlock appears when any k > 0.
- **Queue still growing:** a row `data-testid="queue-growing-runs"`, "k / n" per variant, with k
  runs where `queueGrowing = 1`. A `role="status"` warning containing "queue" appears when any
  k > 0.
- **Metric rows:** neither flag gets a mean ± CI row. Every other metric, including
  `divertedTrips` ("Diverted trips") and `guardPer1000VehKm`, has a mean ± CI row per variant
  and a paired-difference column. The CSV contains every metric in `METRICS`, including both
  flags, in the summary and per-seed sections.

### 5.4 Execution
- **Workers:** experiments run in a pool of `hardwareConcurrency − 1` workers, at least 1. Each
  replicate is independent and deterministic, so results don't depend on the pool size or the
  order replicates finish in.
- **Seeds:** replicate i uses seed `scenario.seed + i`.
- **Test hook:** `weaveTest.runExperiment({ replications, compare })` resolves to
  `{ base: ReplicateResult[]; variant?: ReplicateResult[] }`. The value `compare: 'none'` means no
  variant. Experiments use the loaded scenario's seed and the default classes.

## 4. Vehicle classes

`classes.json` (schema `docs/schema/classes.schema.json`) gives each class:
- size distributions;
- IDM parameters;
- clearance `c0`, `c1`;
- gap-acceptance parameters;
- lateral parameters;
- share.

Every value carries a provenance of `derived`, `proxy` or `assumption`. See VALIDATION.md for
how each was obtained.

## 6. App (revision 3)

### 6.1 Frame record (protocol, engine `writeFrame`)
`FRAME_STRIDE = 11`. Records are written in vehicle-id order, the same order as `vehicles()`.
Fields, in order (`F_*` constants in `protocol.ts`):
- `F_X`, `F_Y`, `F_HEADING`, `F_CLASS`, `F_LENGTH`, `F_WIDTH`, `F_LAYER`: unchanged.
- **`F_SPEED` (7):** the speed v in m/s.
- **`F_SPEED_RATIO` (8):** `v / min(v0_driver, speedLimit of the current segment)`, clamped to
  [0, 1]. This is what the speed colour shows: 0 = stopped, 1 = free flow.
- **`F_Z` (9):** the elevation of the vehicle's centre in m. It is used for rendering only and
  never enters the physics.
  - **On a link:** z is linear in arc length, from `zFromM` at s = 0 to `zToM` at s = L.
  - **On a movement:** z is linear in arc length, from the fromLink's `zToM` to the toLink's
    `zFromM`.
  - **Position:** z is evaluated at the same centre point as x and y (`s − length/2`).
- **`F_SEG` (10):** the index of the segment the vehicle's front is on. Index
  `i < links.length` means `network.links[i]`; otherwise it means
  `network.movements[i − links.length]`.

### 6.2 Run summary and per-link statistics (engine `stats/summary.ts`)
```ts
export function runSummary(sim: Sim, warmupS: number): Record<MetricId, number>
export function segmentStats(sim: Sim): SegmentStat[]
interface SegmentStat {
  id: string; kind: 'link' | 'movement'; lengthM: number; widthM: number;
  entered: number; exited: number; vehicleKm: number; vehicleHours: number;
  meanSpeedKmh: number;      // vehicleKm / vehicleHours (NaN when vehicleHours = 0)
  meanDensityPerKm: number;  // vehicleHours / (lengthM/1000 · t/3600)  (Edie, over [0, t])
  meanFlowVph: number;       // vehicleKm / (lengthM/1000 · t/3600)   (Edie, over [0, t]); = density × speed
  onNow: number; guardActivations: number
}
```
- **`runSummary`:** the §5.2 metrics evaluated at the sim's current time t instead of
  `durationS`. The window is `[warmupS, t]`, and "unfinished" means unfinished at t.
  - `runReplicate(input, seed)` equals `runSummary` of a sim advanced to `durationS`, exactly.
  - `queueGrowing` uses the midpoint of `[warmupS, t]`, with m rounded down to a whole step as
    in §5.2. The sim records the entry queue after every step: `queueAt(step)` returns
    `counters().entryQueue` as it was right after that step, and 0 at step 0 before any
    generation. So the rule is exact at any t, and `runReplicate`'s rule is unchanged.
- **`vehicleKm` per segment:** the sum of the front displacement `ds` while the front is on the
  segment (the same quantity as `diagnostics().vehicleKm`, split by segment). Summed over all
  segments, it equals `diagnostics().vehicleKm`.
- **`vehicleHours`:** `linkStats().vehicleSeconds / 3600`.

### 6.3 App behaviour
1. **Opens ready (revision 4, user decision).** The app opens on the **4-arm junction with
   flyover** preset (`junction4-flyover`), loaded and **paused at t = 0**, with the network
   drawn and a clear prompt over the map (`data-testid="play-prompt"`, text containing
   "Press Play").
   - **Prompt:** the prompt disappears once the run is played or stepped.
   - **No warm-up at page load:** nothing is simulated until the user plays or steps.
   - **Other presets:** `?preset=<id>` opens another preset the same way. `?autoplay` no
     longer exists, because nothing autoplays.
2. **Colour by.** A two-option control "Colour by" (Class / Speed), shown over the map, sets the
   vehicle colour in both 2D and 3D.
   - **Class:** the existing class palette.
   - **Speed:** a continuous ramp over `F_SPEED_RATIO`: red at 0 (stopped), amber at 0.5,
     green at 1 (free flow).
   - **Legend:** a legend for the active mode is always shown on the map
     (`data-testid="legend"`). Class mode shows a swatch and name per class. Speed mode shows
     a gradient bar labelled "Stopped" and "Free flow".
3. **Experiments summary and chart.** After a run, a plain-English summary sits above the
   results table (`data-testid="experiment-summary"`).
   - **What it says:** the number of seeds; the mean delay with its 95% CI; gridlocked and
     queue-growing runs, if any; and, when there is a variant, which variant reduced or
     increased mean delay, by how much and with what CI. A difference whose CI includes 0 is
     described as "no clear difference".
   - **Chart:** with a variant, a small chart (`data-testid="diff-chart"`, `role="img"`, with
     an aria-label) shows the paired difference of each key metric as a percentage of the
     base mean, with its 95% CI as a whisker, around a zero line. The key metrics are mean
     delay (all trips), mean travel time, throughput and mean speed.
4. **3D view.** A "2D / 3D" toggle sits beside the colour control.
   - **Loading:** 3D loads three.js with a dynamic `import()` only when it is first opened,
     and three.js is never in the initial bundle.
   - **Geometry:** roads follow their z-profiles (§6.1), and decks and ramps are visibly
     raised, with pillars under elevated links.
   - **Vehicles:** instanced boxes sized by the frame's length and width and a class height,
     in the same colours as 2D.
   - **Controls:** orbit, pan, zoom and touch.
   - **Class heights (rendering assumption):** motorcycle 1.4 m, car 1.5, auto 1.7, LCV 2.2,
     bus 3.0, truck 3.2.
   - **Failure:** if WebGL is unavailable, the 3D toggle shows a message and the view stays
     2D.
5. **Map inspection (2D).** Hovering (mouse) or tapping (touch) on a vehicle or road shows an
   info card (`data-testid="inspect-card"`) and highlights the selection.
   - **Vehicle card:** class, speed in km/h, the segment id it is on, and length × width.
   - **Road card:** link or movement id, width, lanes (links), speed limit, and the vehicles
     on it now, with their mean speed.
   - **Dismissing:** Escape or a tap on empty ground clears it.
7. **Scenario panel (revision 4).**
   - **Description:** every preset has a one-line `description` (an optional scenario field)
     saying what it shows. It is displayed under the scenario name
     (`data-testid="scenario-description"`).
   - **Demand first:** "Demand (veh/h)" (the total over the OD table) is the first field of
     the run form.
   - **Silk Board demand note:** for Silk Board, a note beside the demand field
     (`data-testid="demand-note"`) says that 60% of the original OD is the tested clean preset
     and that locks start around 70%.
   - **OD table:** collapsed by default for file networks (Silk Board).
   - **OD labels:** junction zones read "Arm k" (k = arm index + 1), so a row is labelled
     "Arm 1 → Arm 2 (veh/h)", matching the arm fields of the form. Other zone ids are shown
     as they are.
   - **Box compliance:** the field is shown only for networks with a junction node (a node
     with ≥ 2 movements, the box rule's definition, §3.4).
   - **Presets:** `ring-busy` is removed. `ring-demo` is renamed "Ring road (car-following
     check)" and `corridor-lanedrop` "Road narrowing", and its description states that
     vehicles enter pre-sorted, so merging at the drop is not simulated.
8. **3D inspection.** In 3D, hovering (mouse) or tapping (touch) a vehicle or road shows the
   same card as 2D (`inspect-card`).
   - **Picking:** CPU raycasting with three.js `Raycaster` against the instanced vehicle mesh
     and the road meshes. Each road triangle maps back to its segment.
   - **No GPU readback:** inspection never reads pixels from the GPU (no `readPixels`).
   - **Test hook:** `weaveTest.worldToScreen3d(x, y, z)` returns page coordinates in the 3D
     view.
6. **Export run.** An "Export run" button is enabled only when the run is paused and t > 0.
   It downloads one JSON file, `weave-run-<presetId|scenario.id>-seed<seed>-t<t>.json`, that
   validates against the zod schema `RunExport` (§6.4; JSON Schema in
   `docs/schema/run-export.schema.json`).
   - **Determinism:** apart from `exportedAt` and `buildSha`, it equals, field for field, what
     Node computes for the same scenario, seed and step count.
   - **CSV downloads:** "Trips CSV" and "Series CSV" buttons, enabled under the same condition,
     download the `trips` and `series` arrays as CSV. They have a header row and one row per
     record, in the field order of §6.4, with empty cells for null.

### 6.4 Run export (`schema/export.ts`, `stats/export.ts`)
```ts
RunExport = {
  manifest: { buildSha: string; engineVersion: string; schemaVersion: number;
              classesHash: string /* 64 hex: SHA-256 of JSON.stringify(classes as sent to the worker) */;
              seed: number; simulatedTimeS: number; steps: number;
              finalStateHash: string /* 8 hex */; exportedAt: string /* ISO 8601 */ };
  scenario: ScenarioInput;                  // as run (the loaded scenario, seed included)
  metrics: Record<MetricId, number | null>; // runSummary(sim, warmupS); NaN → null
  series: SeriesRow[];
  links: SegmentStat[];                     // §6.2; NaN → null
  trips: TripExport[];
  diagnostics: { guardActivations: number; vehicleKm: number; guardPer1000VehKm: number;
                 guardBySegment: Record<string, number>;
                 lockedJunctions: { node: string; sinceS: number }[];
                 reroutes: number; diversions: number };
}
TripExport = { id; origin; destination; classId; tGen; tInsert: number | null; tExit: number | null;
               freeFlowS; delayS; diverted: boolean; unfinished: boolean }
```
- **Trips:** there is one record per generated vehicle since t = 0, in id order
  (`tripRecords(sim)`), and `freeFlowS` is the free-flow time of the route planned at
  generation (`generatedLog`, §2.7).
  - **Completed:** `delayS = tExit − tGen − freeFlowS_driven`, where `freeFlowS_driven` is the
    free-flow time of the route actually driven (`trips()`, so the delay agrees with §5.2). It
    differs from `freeFlowS` only for rerouted vehicles (§2.2).
  - **On the network:** `tExit = null`, and `delayS = t − tGen − freeFlowTravelledS` (delay so
    far, §5.2).
  - **Still queued at entry:** `tInsert = null`, `tExit = null` and `delayS = t − tGen`.
  - **`diverted`:** true if the vehicle was sent to an exit other than its destination
    (§2.2).
  - **`unfinished`:** true when `tExit` is null.
- **Engine additions:** `TripRecord.diverted`, `VehicleView.tInsert` and `VehicleView.diverted`.
  `exportBody(sim)` returns every field except `buildSha`, `engineVersion`, `classesHash`,
  `exportedAt` and `scenario`. The worker answers the protocol message
  `{ type: 'export', nonce }` with `{ type: 'export', nonce, body }`.
- **Node CLI** `packages/engine/bin/weave.mjs` (`pnpm --filter @weave/engine sim -- …`):
  - **Replay:** `--scenario <run.json>` accepts a run export, validates it with `RunExport`,
    rebuilds the sim from `scenario` with the default classes and runs
    `manifest.steps` steps.
  - **Network files:** file networks are read from `apps/web/public/data/<id>.json`, or from
    `--network`.
  - **Output:** it prints `{ stateHash, expected, match, simulatedTimeS }` as JSON and exits
    with 0 if the hash matches, or 1 if it doesn't.
  - **Classes check:** it first checks that the SHA-256 of the default classes equals
    `manifest.classesHash`. If not, it exits with 2 and says so.
  - **Plain scenario:** `--scenario <scenario.json>` with a plain scenario (no manifest) runs
    `durationS` (or `--steps N`) and prints `{ stateHash, simulatedTimeS, metrics }`.
  - **Library form:** `replayExport(run, network?)` in `src/replay.ts` does the same as a
    function, without the classes check.
