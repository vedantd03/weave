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
| Length, width: motorcycle (1.8 × 0.6 m), auto (2.6 × 1.4 m) | **assumption** | constant in the dataset (not measured per vehicle) |
| Class shares | derived | vehicle counts |
| v0 | **proxy** | 85th-percentile spot speed. Traffic is near capacity, so free-flow vehicles are rare. |
| s0 = 2 m | **assumption** | Treiber & Kesting (2013). The data has almost no slow or stopped following. |
| T | derived, **conditional** | IDM steady-state inversion, conditional on the assumed s0 and the proxy v0 (§4) |
| a, b | **assumption informed by data** | percentiles of position-derived acceleration. The value is set by the smoothing window (§3). |
| Clearance c0 | derived | p10 of accepted lateral gaps, halved per side |
| Clearance c1 | derived for auto only; otherwise assumption (0) | §5 |
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
0–0.12 m.

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
| Simulation | 46.8–47.3 km/h | 124.5–133.4 veh/km | 5,896–6,263 veh/h |

The simulated road carries the observed flow at about 6 km/h more speed and 15–24 veh/km less
density than observed. In other words, the calibrated vehicles are somewhat less "dense" than
real Chennai traffic at this flow.

**Likely contributors**, none of them adjusted:
- s0 is assumed (2 m), and T is conditional on it (§4).
- v0 is a near-capacity proxy.
- Strip rounding adds 0–0.12 m to lateral gaps (§5).
- The real section is fed by an upstream signal, so its arrivals are platooned, not Poisson.

Lane mode reuses the strip-calibrated parameters, so two lanes carry about 5,500 veh/h. The UI
labels lane mode as a **theory check**, not a calibrated alternative.

## 7. Engine safety net: collision guard (ADR-015)

IDM is collision-free only while every leader brakes within its limits. After integration, a
kinematic guard stops a front from passing its leader's new rear. The engine counts every
activation, and the app shows the count with a per-10k-vehicle-steps rate in the results panel.

| Scenario (1,000 m, 30 min) | Activations |
|---|---|
| Any corridor, lane mode | 0 |
| Plain 7 m and lane-drop corridor at 6,000 veh/h, strip mode, after the grid fix | 0 |
| 11.2 m straight road at 6,000 veh/h, strip mode | 0 |
| Before the grid fix, 7.2 → 7.0 m narrowing | 1,644–3,057 (the defect the node-saturation test found) |

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
