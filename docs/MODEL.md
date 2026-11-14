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

### 1.5 Strips: `network/strips.ts`

```ts
export function stripLayout(roadWidthM: number, targetStripM: number): { n: number; w: number }
export function occupiedStrips(yCentre: number, width: number, clearance: number, layout: { n: number; w: number }): [number, number]
export function sweptStrips(yA: number, yB: number, width: number, clearance: number, layout: { n: number; w: number }): [number, number]
export function laneStrip(yCentre: number, layout: { n: number; w: number }): [number, number]
```

- **Layout:** `n = max(1, round(roadWidthM / targetStripM))` and `w = roadWidthM / n`, so the
  strips tile the road exactly.
  - **Strip mode:** the target is `scenario.stripWidthM`, 0.3 m by default.
  - **Lane mode:** the target is `roadWidthM / lanes`, so `n = lanes` and one strip is one
    lane.
- **Occupancy (strip mode):** the body plus clearance on both sides covers
  `[left, right) = [y − width/2 − c, y + width/2 + c)`. Then `lo = floor(left / w)` and
  `hi = ceil(right / w) − 1`, each clamped to `[0, n − 1]`. The result is the inclusive pair
  `[lo, hi]`.
- **During a lateral manoeuvre** from yA to yB, the vehicle occupies
  `sweptStrips = [min(lo_A, lo_B), max(hi_A, hi_B)]`.
- **Occupancy (lane mode):** `laneStrip = [k, k]` with `k = clamp(floor(y / w), 0, n − 1)`.
  The vehicle occupies its whole lane regardless of its width.
- **Clearance:** `c(v) = c0 + c1·v` (class parameters, §4), evaluated at the current speed.

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

## 2. Lateral model (M2), outline

**Generalised MOBIL over strip offsets:**
- **Candidates:** lateral targets within a horizon of reach τ·maxSpeedMps, discretised by strip
  width.
- **Incentive:** `ã_c − a_c + p·(ã_n − a_n) > Δa_th + bias_route`.
- **Safety:** the new follower's acceleration must satisfy `ã_n ≥ −b_safe`.
- **Lane mode:** the candidates are the adjacent lanes, which is exactly MOBIL.
- **Commit order:** decisions come from the snapshot and are committed in order
  `(s desc, id asc)`, each re-checked against the occupancy already committed.

Detailed equations will be added at the start of M2.

## 3. Junctions (M3), outline

- **Movement paths:** each movement has an internal path with conflict areas computed from
  intersecting swept paths.
- **Signals:** movement-specific signal groups, with amber and all-red.
- **Priority:** gap acceptance (critical gap and follow-up headway) with commitment.
- **Spillback:** a vehicle enters a movement only if there is space beyond it, applied with
  compliance probability `boxCompliance`.
- **Gridlock:** gridlock is detected and reported.
- **Layers:** conflicts exist only between movements at the same node.

Detailed equations will be added at the start of M3.

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
