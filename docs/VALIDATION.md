# Validation

This page records what the model is checked against, what the data supports, and where the model
and the data disagree. Mismatches are reported, not tuned away. All numbers are reproducible from
the scripts and tests named next to them.

**Data source:** Kanagaraj V., Asaithambi G., Toledo T., Lee T.-C. (2015), *Trajectory data and
flow characteristics of mixed traffic*, Transportation Research Record 2491. The data covers two
15-minute periods on 13 Feb 2014 at a six-lane separated arterial in Chennai, with 0.5 s
sampling and 3,005 vehicles.

## 1. Data consistency (D6, `data-pipeline/tests/test_d6_consistency.py`)

| Check | Result | Reference |
|---|---|---|
| Fully tracked region (from the data) | x = 58.2–218.0 m (L = 159.8 m); 98.1% of vehicles span it | — |
| Flow, counted at 5 lines over 1,718.7 s | **6,095 veh/h** (counts 2,905–2,913) | paper: 6,010 veh/h; tolerance ±339 (Poisson + spread between lines) |
| Position-derived speed ÷ dataset speed column | **1.922** (median; LS 1.902), stable across classes (1.920–1.923), files and speed quartiles | ≠ 1, so the speed and acceleration columns are not used |
| Edie density vs line flow ÷ space-mean speed | **148.4** vs 148.45 veh/km (bound ±3.4) | identity check |
| Space-mean speed | **41.1 km/h** | — |

**Inconsistency in the paper.** 6,010 veh/h ÷ 123.5 veh/km = 48.7 km/h, which contradicts the
measured 41.1 km/h, so the paper's 123.5 veh/km is not used as a reference. An earlier figure of
128 veh/km covered the untracked ends of the section and is withdrawn.

## 2. Parameter provenance

Every value in `classes.json` carries one of three labels:
- **derived:** computed from the data.
- **proxy:** computed from the data, but standing in for a quantity the data cannot identify.
- **assumption:** not identified by the data.

| Parameter | Provenance | How |
|---|---|---|
| Length, width: car, bus, truck, LCV | derived | 21 quantiles of measured sizes |
| Width cap 2.6 m | **data correction** (user decision) | 44 of 95 buses (up to 3.27 m) and 1 of 40 LCVs (2.64 m) measured wider than 2.6 m, the usual legal maximum; likely video measurement and mirrors. Capped at 2.6 m before the quantiles. Bus width quantiles 0/5/50/95/100% are now 2.04/2.33/2.59/2.60/2.60 m. |
| Length, width: motorcycle (1.8 × 0.6 m), auto (2.6 × 1.4 m) | **assumption** | constant in the dataset (not measured per vehicle) |
| Class shares | derived | vehicle counts |
| v0 | **proxy** | 85th-percentile spot speed. Traffic is near capacity, so free-flow vehicles are rare. |
| s0 = 2 m | **assumption** | Treiber & Kesting (2013). The data has almost no slow or stopped following. |
| T | derived, **conditional** | IDM steady-state inversion, conditional on the assumed s0 and the proxy v0 (§4) |
| a, b | **assumption informed by data** | percentiles of position-derived acceleration. The value is set by the smoothing window (§3). |
| Clearance c0 | derived | p10 of accepted lateral gaps, halved per side |
| Clearance c1 | derived for auto only; otherwise assumption (0) | §5 |
| Lateral speed (max) | derived for motorcycle, car, auto, bus (bus: n = 18, small sample); **assumption** for truck (bus value) and LCV (car value) | p85 of per-episode peak lateral speed of deliberate moves (§5) |
| Critical gap, follow-up | assumption | HCM 2016 (4.1/2.2 s; heavy vehicles 5.1/3.1 s) |
| MOBIL politeness, threshold | assumption | 0.2, 0.1 m/s² |
| Truck T | assumption | only 3 usable steady-following samples, so the car value is borrowed |

**Flagged data quirk.** 5 of 800 "cars" are smaller than any real car: width under 1.2 m, and
3 of them also shorter than 3 m. They are most likely misclassified motorcycles. They are kept as
measured. They affect only the 0–5% size quantiles:

| Car size | Quantiles 0 / 5 / 50 / 95 / 100% |
|---|---|
| Length, with them | 1.98 / 3.85 / 4.61 / 5.69 / 6.97 m |
| Length, without them | 3.26 / 3.87 / 4.62 / 5.69 / 6.97 m |
| Width, with them | 0.57 / 1.31 / 1.58 / 1.97 / 2.59 m |
| Width, without them | 1.20 / 1.32 / 1.58 / 1.97 / 2.59 m |

## 3. Acceleration percentiles depend on the smoothing window

Acceleration is computed with a quadratic Savitzky–Golay filter at 0.5 s sampling. Each cell is
a (p95) / b (−p5) in m/s²:

| Class | 5 pts | 7 pts | **9 pts (used)** | 11 pts | 15 pts |
|---|---|---|---|---|---|
| Motorcycle | 3.73/3.80 | 2.03/2.09 | **1.25/1.33** | 0.87/0.96 | 0.50/0.58 |
| Car | 3.15/3.05 | 1.71/1.63 | **1.07/1.03** | 0.75/0.77 | 0.51/0.54 |
| Auto | 3.42/3.37 | 1.83/1.70 | **1.08/1.02** | 0.72/0.68 | 0.40/0.39 |
| Bus | 3.19/3.14 | 1.71/1.52 | **1.09/0.90** | 0.74/0.58 | 0.46/0.40 |
| Truck | 3.56/3.58 | 1.76/2.13 | **0.93/1.17** | 0.62/0.96 | 0.40/0.48 |
| LCV | 3.28/3.34 | 1.86/1.50 | **1.24/0.89** | 0.80/0.64 | 0.47/0.39 |

**The values never settle.** They fall by roughly 2× per window step. Most of the change comes
from a 2–3 s tracking wobble whose amplitude does not depend on vehicle class, which isn't
plausible as vehicle dynamics. The 9-point (4 s) window is the shortest that suppresses it. That
is why a and b are labelled assumptions informed by the data, not derived values.

## 4. Desired headway T (IDM inversion)

s0 = 2 m. Samples with v > 0.9·v0 are excluded before inverting, because `1 − (v/v0)⁴ ≤ 0` near
v0 would give NaN. The exclusions are counted. Leaders are found with the engine's rule on the
0.25 m kerb-anchored strip grid.

| Class | T (s) | Steady samples used | Dropped (v > 0.9·v0) |
|---|---|---|---|
| Motorcycle | 0.649 | 2,261 | 312 (12.1%) |
| Car | 0.503 | 1,565 | 347 (18.1%) |
| Auto | 0.946 | 447 | 218 (32.8%) |
| Bus | 0.816 | 136 | 60 (30.6%) |
| LCV | 0.982 | 65 | 33 (33.7%) |

**Sensitivity of T.** Each cell is T at v0 × 0.9 / 1.0 / 1.1:

| s0 | Motorcycle | Car | Auto | Bus | LCV |
|---|---|---|---|---|---|
| 1 m | .721/.745/.808 | .519/.596/.653 | 1.105/1.053/1.086 | .765/.919/.962 | 1.530/1.079/1.063 |
| 2 m | .622/.649/.721 | .425/.503/.565 | .991/.946/.986 | .662/.816/.863 | 1.430/.982/.965 |
| 3 m | .522/.555/.627 | .328/.413/.476 | .888/.841/.875 | .556/.716/.764 | 1.326/.885/.867 |

**Effect of the strip-grid revision.** Moving from the old grid (0.3 m tiles of W/round(W/Δ)) to
the 0.25 m kerb-anchored grid changed T by less than 3% for every class.

## 5. Lateral clearance

| Class | c at p5 | **c at p10 (used)** | c at p15 |
|---|---|---|---|
| Motorcycle | 0.226 | **0.333** | 0.412 |
| Car | 0.279 | **0.393** | 0.482 |
| Auto | 0.211 | 0.323 (pooled) | 0.403 |
| Bus | 0.264 | **0.368** | 0.452 |
| Truck | 0.387 | **0.472** | 0.514 |
| LCV | 0.332 | **0.454** | 0.548 |

**Auto speed slope c1 (sensitivity check).** The speed slope passed its pre-set identification
rule for autos only, and only just: slope 0.049 ± 0.018 per m/s (2.7 SE), over a speed span of
exactly the 6 m/s threshold. The rule was fixed before the data was seen, so the fit is kept:
c0 = 0.050 m and c1 = 0.0245 s, giving c = 0.30 m at 10 m/s.
- **With c1 forced to 0:** c0 = 0.323 m at every speed.
- **Effect:** autos are slightly wider below about 11 m/s and slightly narrower above. T for
  autos moves from 0.946 to 0.940 s, and every other class changes by 0.002 s or less, which is
  negligible.

**Strip rounding.** Two vehicles side by side are allowed only if a strip boundary lies between
their clearance edges. So the smallest allowed body gap lies in `[c_A + c_B, c_A + c_B + Δ)`. It
is never a full strip per side, because the two vehicles share the boundary. In the engine test
(`packages/engine/test/unit/clearance.test.ts`) the measured minimum exceeds c_A + c_B by
0–0.15 m on the 0.25 m grid.

**Lateral speed of deliberate moves** (`data-pipeline/src/weave_data/lateral.py`, test D8).
The cap on lateral speed is now estimated from deliberate moves only. The old value, p95 of
|lateral speed| over all samples, was dominated by drift and noise, and it made merges about
twice too slow.
- **Episodes:** a monotonic lateral displacement of **at least 1 m**, measured on 5-point
  Savitzky–Golay smoothed position.
  - Reversals smaller than the hysteresis δ = 0.056 m (4·√2·σ_s, with position noise
    σ_y = 0.014 m) are ignored.
  - An episode splits at a pause of ≥ 2 s with |v_y| < 0.036 m/s.
  - Only fully observed episodes are used.
- **Statistic:** the peak |v_y| of each episode (3-point central difference, noise sd
  0.020 m/s). The class value is **p85 of the episode peaks**.

| Class | Episodes | p75 / **p85 (used)** / p95 (m/s) | Time to cross 3.5 m | Before |
|---|---|---|---|---|
| Motorcycle | 552 | 0.74 / **0.856** / 1.12 | 4.1 s | 0.57 |
| Car | 145 | 0.71 / **0.775** / 0.99 | 4.5 s | 0.46 |
| Auto | 81 | 0.57 / **0.634** / 0.86 | 5.5 s | 0.37 |
| Bus | 18 | **0.613** (derived, small sample) | 5.7 s | 0.36 |
| Truck | 1 | **0.613**, the bus value (assumption) | 5.7 s | 0.41 |
| LCV | 6 | **0.775**, the car value (assumption) | 4.5 s | 0.45 |

**Heavy vehicles** (user decision). The bus uses its own value from 18 moves, flagged as a small
sample. Trucks (1 move) borrow the bus value; their own would be 0.599 m/s. LCVs (6 moves) borrow
the car value; their own p85 would be 0.702 m/s. Both borrowed values are labelled assumption.
Before this, the three classes used a pooled 0.817 m/s, which overstated heavy vehicles.

**Partly observed moves are excluded.** 1,690 moves are cut off by the start or end of a
trajectory, or by a flagged stretch, so only part of each move is seen.
- **Expected effect:** a partly observed move's measured peak can only be at or below its true
  peak, so including these moves should *lower* p85.
- **Observed effect:** including them *raises* p85 by 13–20%. That points to smoothing
  artefacts at the ends of a stretch. There, the speed comes from a one-sided fit, and it is
  inflated.
- **Check:** 26.2% of these moves have their peak within 2 samples of the end of a stretch, and
  21.4% have it on the very last or first sample.
- **Effect of dropping edge peaks:** dropping peaks within 2 samples of an end lowers their p85
  (car 0.92 → 0.84 m/s, bus 0.82 → 0.71). It still stays above the fully observed p85, so edge
  artefacts explain part of the rise, not all of it.
- **Decision:** these moves stay excluded. Details are in `build/report.json`, under
  `lateral_episodes.partial_episode_edge_check`.

## 6. Simulated road vs Chennai: free-flow branch only

`apps/web/public/data/chennai_fd.json` holds 28 one-minute Edie points. Their speeds lie between
37.2 and 45.0 km/h, so they cover the **free-flow branch only**. They do **not** validate
capacity, congestion or the effect of road width.

**Mismatch, documented and not tuned.** The Chennai section carries about 6,000 veh/h on about
11.2 m. The simulation used the same width and demand, strip mode, the calibrated classes and the
Chennai composition, and computed Edie measures over the middle 160 m for 900 s after a 300 s
warm-up, over 5 seeds:

| | Space-mean speed | Density | Flow |
|---|---|---|---|
| Chennai (observed) | 41.1 km/h | 148.4 veh/km | 6,095 veh/h |
| Simulation | 46.8–47.4 km/h (mean 47.1) | 124.5–133.1 veh/km (mean 129.0) | 5,899–6,263 veh/h |

The simulated road carries the observed flow at about 6 km/h more speed and 15–24 veh/km less
density than observed. In other words, the calibrated vehicles are somewhat less "dense" than
real Chennai traffic at this flow.

**Likely reasons for the gap.** The calibration stays as it is. None of these was adjusted.
- **v0 is a p85 proxy.** Traffic is near capacity, so true desired speeds can't be seen.
  v0 is the 85th-percentile spot speed. At this density simulated vehicles interact
  little, so they cruise close to v0, which is a high percentile of observed speed, not
  its mean.
- **T depends on the assumed s0 and the proxy v0** (§4). T moves by up to about 20% under
  s0 ± 1 m or v0 ± 10%.
- **No roadside friction.** The model has no bus stops, parked vehicles, pedestrians, side
  access or kerbside activity. All of these slow real arterial traffic, and none is in the
  data's parameter set.
- **Strip rounding** adds 0–0.12 m to lateral gaps (§5).
- **Arrivals:** the real section is fed by an upstream signal, so its arrivals are
  platooned, not Poisson.

**Sensitivity: v0 reduced by 10%.** The same runs (5 seeds, same Edie region and period),
with every class's v0 multiplied by 0.9:

| | Space-mean speed | Density | Gap to observed speed explained |
|---|---|---|---|
| Baseline (calibrated) | 47.1 km/h | 129.0 veh/km | — |
| v0 × 0.9, all else unchanged | **42.1 km/h** (41.9–42.3) | 144.5 veh/km | **5.0 of 6.0 km/h (84%)** |
| v0 × 0.9 with T re-inverted at that v0 (§4, s0 = 2 m row) | 42.2 km/h (42.0–42.5) | 144.2 veh/km | 4.9 of 6.0 km/h (82%) |
| Chennai (observed) | 41.1 km/h | 148.4 veh/km | — |

**Reading:** at this flow the simulated speed scales almost one-for-one with v0. A 10% lower v0
explains about 84% of the speed gap and closes most of the density gap (to 145 vs 148 veh/km).
The result is therefore governed mainly by the v0 proxy. This is a sensitivity result, not a
recalibration: nothing in the data identifies v0 × 0.9 as the right value, so `classes.json`
is unchanged. Script: the Edie measurement above with v0 scaled in the class table.

Lane mode reuses the strip-calibrated parameters, so two lanes carry about 5,500 veh/h. The UI
labels lane mode as a **theory check**, not a calibrated alternative.

## 7. Engine safety net: collision guard (ADR-015)

IDM is collision-free only while every leader brakes within its limits. After integration, a
kinematic guard stops a front from passing its leader's new rear. The engine counts every
activation, by segment.
- **Unit:** the rate is reported **per 1,000 vehicle-km**: the app's live panel and the
  experiment metric `guardPer1000VehKm`.
- **Why not per vehicle-step:** the old unit divided by vehicle-steps. In gridlocked runs most
  vehicle-steps are spent standing still, where the guard cannot act, so that unit diluted the
  rate.

| Scenario (1 h, 3 seeds unless noted) | Per 1,000 vehicle-km | Per 10k vehicle-steps |
|---|---|---|
| Corridors (2,000 and 4,000 veh/h, strip and lane mode); lane-drop preset | 0 | 0 |
| On-ramp merge preset | 3.1–6.9 | 0.08–0.18 |
| 4-arm signalised junction preset | 23.0–23.4 | 0.25–0.26 |
| 4-arm junction with flyover | 41.7–51.7 | 0.57–0.69 |
| Silk Board preset (1,770 veh/h), 10 seeds | 64.9 ± 5.6 (50.5–79.1) | 0.86–1.32 |

**Old vs new on Silk Board, per vehicle-km.** Before this revision, Silk Board showed 0.07–0.27
per 10k vehicle-steps; the new engine shows about 1.0. Both were rerun over 10 seeds, 1 h, at
the old preset demand (about 2,950 veh/h):

| Engine | Locked junctions per seed | Per 10k vehicle-steps | **Per 1,000 vehicle-km** |
|---|---|---|---|
| Old (commit a9b56d6) | 5–18 | 0.06–0.30 | **45–99 (mean 68.6)** |
| New (this revision) | 1–19 | 0.19–1.27 | **72–181 (mean 122.8)** |
| New, at the new preset (60%) | 0 | 0.86–1.32 | 51–79 (mean 64.9) |

- **What normalisation explains:** most of the jump in the per-step rate. The old runs spent
  about 10 million vehicle-steps to drive about 2,000 vehicle-km, because most vehicles were
  standing.
- **What it does not explain:** at the same demand, the new engine still has about 1.8 times
  the activations per vehicle-km. The rate is highest in the seeds that keep flowing (165–181
  in the 4 seeds with 1–5 locked junctions; 72–106 in the heavily locked ones). So the guard
  acts in moving, dense, cutting-in traffic, which this revision lets through instead of
  locking.
- **Not attributed further:** this revision changed lateral speeds, the deadlock breaker, the
  unchanged-follower rule, the band rules and vehicle widths, all at once.

**Where the guard acts** (top 5 segments, summed over 10 seeds):

| Silk Board preset (1,770 veh/h) | Activations | Share |
|---|---|---|
| link 245809758 (7 m) | 148 | 9.5% |
| link 160556513#0 (6 m) | 133 | 8.6% |
| link 464465165#0 (10.5 m) | 124 | 8.0% |
| link 1553783842#0 (6 m, the minor approach of §9) | 110 | 7.1% |
| link 160331539#1 (3.5 m) | 100 | 6.5% |

At the old demand, one 3.5 m link, **1317811589#1**, takes 30.6% of all activations (1,194).
The others are 160556513#0 (9.9%), 1553783842#0 (5.5%), 256259311#1 (5.4%) and 229976708, a
3.25 m link (4.5%). All of the top locations are links where queues form, none of them
junction movements.

**Correction.** Earlier reports of 80–740 activations on corridors came from a counting artifact:
a stopped vehicle whose allowed displacement was slightly negative was counted although nothing
changed. The counter now counts only real reductions. The guard's behaviour itself is unchanged.

## 8. Known simplifications

- **Lane drops:** vehicles enter already sorted into the continuing lanes (band rule, MODEL.md
  §2.3), so merging at the drop itself is not simulated.
  - **What was tried:** a band zone that let vehicles use the dropped lane.
  - **Result:** saturated throughput collapsed without a dedicated zipper or forced-merge model
    (lane mode about 2,650–3,050 veh/h, strip mode 0–2,300, against about 5,500–6,200 on the
    plain road).
  - **Status:** a merge model is future work.
- **Box compliance:** `boxCompliance` defaults to 1.0. Lower values are an editable assumption,
  since there is no source for Indian junctions.
- **Demand inputs:** Silk Board demand is not observed. Scenarios use plausible, editable OD
  rates.
- **On-ramp merging** is modelled (generalised MOBIL over strips, lateral speeds from §5). It was
  rerun after the lateral speeds changed. A deadlock found at the end of the acceleration lane
  was traced and fixed: the **unchanged-follower rule**, MODEL.md §2.4. A car stopped at the
  end of the lane, with a motorcycle 0.05 m behind it overlapping both its current and target
  strips, was blocked by that motorcycle's gap floor, although edging sideways changes nothing
  for it. This locked 1–2 seeds in 10 even at 1,200 + 300 veh/h.

  On-ramp preset geometry (300 m acceleration lane), 1 h, 10 seeds after the fix (delay
  includes unfinished trips, §10):

  | Main + ramp demand (veh/h) | Throughput (veh/h) | Mean max entry queue | Mean delay | Gridlocked runs |
  |---|---|---|---|---|
  | 1,600 + 400 | 1,992 ± 38 | 1.1 | 3.2 ± 0.2 s | 0 / 10 |
  | **2,000 + 500 (preset)** | **2,479 ± 80** | 1.0 | **6.4 ± 3.1 s** | **0 / 10** |
  | 2,400 + 600 | 2,710 ± 620 | 221 | 161 ± 328 s | 1 / 10 |
  | 2,800 + 800 | 2,854 ± 87 | 532 | 371 ± 69 s | 0 / 10 |

  So the merge section saturates at about **2,850 veh/h**; above that the excess queues at the
  entries. The table was rerun after the width cap and the band-centred move.
  - **Open:** at 2,400 + 600, one seed jams, with an entry queue of 2,174. Before those two
    changes all 10 seeds flowed at that demand, with throughput 3,000 ± 57 veh/h. That jam has
    not been traced. The preset runs below it, with no gridlock in any of the 10 seeds. Before the fix the preset gridlocked in 5 of 10 seeds. The capacity is a model
  result. It is not validated, because the Chennai data has no merge.

## 9. Silk Board (imported network)

The network comes from OSM through netconvert (`data/osm/README.md`). It has 117 links and 154
movements across three levels: ground, the Silk Board flyovers, and the Ragigudda–Silk Board
double-decker. Signal timings are netconvert's defaults (90 s cycles; 16–85 s of green per
movement). **Demand is not observed**; the OD is plausible and editable. One simulated hour runs
in about 5–9 s per seed.

**Correction.** This page used to say that "2–5 junctions lock within the hour" at
1,800–3,000 veh/h. That understated it. The previous default preset (125 veh/h per entry lane,
about 2,950 veh/h), run over 10 seeds for 1 hour, gave:
- **Locked junctions:** 10.9 ± 3.2 per seed (range 5 to 18).
- **Trips:** 1,746 incomplete against 960 completed.
- **Entry queues:** around 590 vehicles.
- **Speed:** a network mean of about 6 km/h.

**Tracing the locks.**
1. **Swap deadlock at a diverge (a rule defect, fixed).** The first lock was at node
   13337723222 in 8 of 10 seeds. Following "who waits for whom" from that junction ended on link
   1155963376#1. There, vehicles that had reached the end of the link in the wrong lane band for
   their next movement stood side by side, each blocking the strips the other needed. Neither
   could move sideways, so neither could leave.
   - **Fix:** the deadlock breaker (MODEL.md §2.2, ADR-023). After 20 s stuck at a lane-band
     obstacle, a vehicle takes the alternative movement whose band it fits best and is rerouted
     from there. If its destination can no longer be reached, it goes to the nearest reachable
     exit and is counted as **diverted**.
   - **Result:** at the old demand, 6 of 10 seeds became lock-free.
2. **Remaining locks: spillback at too much demand.** In seed 44 the first lock was at node
   10282769907. The wait-for chain ends at a signal stop line (movement
   160331538#0>1167293938, during a long red). Its queue fills the short links upstream, and
   don't-block-the-box then holds the junctions behind it. This is the intended behaviour of
   the rules under oversaturation, not a defect.
3. **Acceleration-lane deadlock (a rule defect, fixed).** This was found on the on-ramp (§8).
   The unchanged-follower rule applies everywhere.

4. **Wide buses at entries and narrow bands (rule defects plus a data error, fixed in
   revision 2).** With gridlock gone at 60%, seeds 46 and 47 still had entry queues of 156–211
   and exited only 1,355–1,567 of 1,790 veh/h. Those entry queues grew even at 40% demand, so
   lowering demand would not have fixed them. Traced:
   - **The entry stops.** Two entry links (256259311#0 and 290639911) stopped admitting
     vehicles for good once a wide bus reached the head of the queue. Every insertion position
     keeps edge clearance, so none of them put the 2.89 m bus inside a 3 m band. A 3.09 m bus
     can never lie inside a 3 m band at all.
   - **The pile-up.** In seed 47, a 2.98 m bus stood in front of a 3.0 m band at y = 1.61. The
     only centres that fit (1.49–1.51) were off its 0.25 m grid, and it waited for over 1,300 s.
     82 vehicles on the minor approach 1553783842#0, which yields to its movement, piled up
     behind it. The vehicle count in the network grew, while the entry queue did not.
   - **Fixes:**
     - **Band-centred insertion candidate and lateral move** (MODEL.md §2.3, §2.4, strip mode).
     - **Width cap:** measured widths are capped at 2.6 m as a data correction (§2).
     - **Overhang rejected:** a "cover the band" rule for vehicles wider than their band was
       tried and rejected (user decision). Every Silk Board link and band is at least 3.0 m
       wide, so a 2.6 m bus always has 0.4 m of room.

**Where queues stop staying bounded and where locks start** (final engine, 10 seeds, 1 h,
demand as a share of the original OD; "queue still growing" as defined in MODEL.md §5.2):

| Demand | Total (veh/h) | Entry queue still growing | Vehicles in network, mid → end | Locked at end | First lock |
|---|---|---|---|---|---|
| 50% | 1,475 | 0 / 10 | flat (54–72) | 0 / 10 | none |
| **60% (preset)** | **1,770** | **0 / 10** | **flat (67–103)** | **0 / 10** | none |
| 70% | 2,065 | 0 / 10 | grows in 4 seeds (up to 134 → 454) | 3 / 10 | 2,400–3,300 s |
| 80% | 2,360 | 0 / 10 | grows (up to 336 → 1,199) | 5 / 10 | 1,560–2,760 s |
| 90% | 2,655 | 0 / 10 | grows | 8 / 10 | 1,140–3,060 s |
| 100% | 2,950 | 3 / 10 | grows | 10 / 10 | 1,140–2,760 s |

- **Locks start at 70%,** and that is also where the vehicle count in the network starts
  growing.
- **Entry queues stop staying bounded only at 100%.** Between 70% and 90% the internal links
  absorb the excess, so the entry-queue flag alone understates the instability there. The
  network count shows it.
- **Preset:** 60% of the original OD, **1,770 veh/h** (every row × 0.6, rounded to 1 veh/h;
  `packages/engine/scripts/silkboard-od.mjs`). It is the highest tested level at which all 10
  seeds keep entry queues bounded, keep the network count flat and lock no junction. 50% also
  passes.

**Preset results** (10 seeds, 1 h):

| Metric | Mean ± 95% CI |
|---|---|
| Throughput | 1,770 ± 37 veh/h |
| Completed / incomplete trips | 1,548 ± 37 / 84 ± 8 |
| Mean delay, all trips (incl. unfinished, §10) | 49.3 ± 5.2 s |
| Mean delay, completed trips only | 49.3 ± 4.7 s |
| Mean speed | 30.0 ± 0.8 km/h |
| Max entry queue | 0.2 ± 0.3 veh |
| Diverted trips (in the window) | 101 ± 7 |
| Gridlocked runs / queue still growing | 0 / 10, 0 / 10 |
| Collision guard | 64.9 ± 5.6 per 1,000 vehicle-km |

The all-trips and completed-only delays now agree, because no run builds a queue that never
clears. The earlier 105 ± 59 s came from the stalled entries in seeds 46 and 47.

**Limitation: diversions.** The deadlock breaker diverts about **101 trips per run, about 6%
of the trips generated in the window**, to an exit other than their destination. Real drivers
do this too, but the share is a model output and is not validated. Each run's count is in the
Experiments view and the CSV (`divertedTrips`).

**Engine defects that Silk Board exposed earlier, now fixed** (ADR-022):
1. Box space measured only on 7 m exit links.
2. Bands wider than their movements.
3. Wide vehicles unable to reach a narrow band because of edge clearance.
4. Merge projections of vehicles waiting at a red light.
5. Free-flowing traffic counted as box-blocking.

**Likely remaining contributors:** short inter-junction links with lane-specific bands from
netconvert, default signal timings, and the lane-drop simplification (§8). The Silk Board
results show the network's behaviour **in this model**. They are not a prediction of real Silk
Board delays.

## 10. Experiments: delay definition and results

**Definition (MODEL.md §5.2).** `meanDelayS` is averaged over **every vehicle generated in the
window**, finished or not.
- **Finished trip:** delay = exit time − generation time − free-flow time of its route.
- **Unfinished trip:** delay so far = run end − generation time − free-flow time for the
  distance it has **actually travelled**.
  - A vehicle still waiting in its entry queue has travelled 0 m, so its delay is the full time
    since it was generated.
- **Check:** an engine test verifies the accounting identity exactly. Total delay = total
  vehicle-seconds in the network and the entry queues − total free-flow time for the distance
  travelled, within a dt bound derived in the test.

`meanDelayCompletedS` keeps the old completed-trips-only mean for comparison. A run whose
detector shows any locked junction at the end is flagged as **gridlocked**. The Experiments view
shows "Gridlocked runs k / n" for each variant and warns when k > 0.

**Flyover on the 4-arm junction preset.** 10 paired seeds, 1 h, common random numbers:

| Variant | Mean delay, all trips | Completed only | Throughput | Gridlocked |
|---|---|---|---|---|
| Flyover off | 55.2 [53.2, 57.1] s | 55.8 s | 3,021 veh/h | 0 / 10 |
| Flyover on, same timings | 39.3 [37.8, 40.8] s | 39.6 s | 3,024 veh/h | 0 / 10 |
| Flyover on, retimed (Webster) | 36.2 [35.2, 37.2] s | 36.5 s | 3,022 veh/h | 0 / 10 |

| Paired difference | Mean delay, all trips |
|---|---|
| Same timings − off | **−15.9 s** [−17.8, −13.9] |
| Retimed − same timings | **−3.1 s** [−4.4, −1.8] |
| Retimed − off | −19.0 s [−21.2, −16.8] |

These replace the earlier figures (−14.5 s and −2.4 s, 5 seeds, completed trips only, before the
lateral-speed and rule changes). Nearly every trip finishes here, so the two delay definitions
agree to within 0.6 s. The same holds for the Silk Board preset now (§9).

**Run flags.** Two per-run flags are shown in the Experiments view and written to the CSV:
- **Gridlocked:** at least one junction is locked at the end of the run.
- **Queue still growing:** over the second half of the window, the entry queue grew by more than
  one minute of total demand and by at least 10 vehicles. The threshold is an assumption
  (MODEL.md §5.2).

Each flag appears as a "k / n" row per variant, with a warning when k > 0. Diverted trips have
their own row, with a mean, CI and paired difference.

## 11. Other checks

- **T15b, signal discharge vs a plain link:** the saturation flow fitted from signal cycles is
  0.4830 veh/s. The discharge rate of a plain link from a standing queue is 0.4566 veh/s. The
  difference is within the test's derived bound (0.0827 veh/s). An earlier figure of 0.274
  veh/s was obsolete and is withdrawn.
- **Cross-runtime determinism:** the state hash after the same seed and steps is bit-identical
  in **Node, Chromium and WebKit**. The test covers 4 checks: ring, corridor apply, corridor
  multi-step and Silk Board. **Firefox is untested**, because Playwright's Firefox failed to
  launch on the development machine ("Could not find profile folder"). The engine avoids every
  operation whose rounding ECMAScript leaves open, so no difference is expected, but none is
  claimed.
- **Lighthouse** (deployed site, default mobile settings, run by the user): Performance **95**,
  Accessibility **100**, Best Practices **100**.
