# OpenStreetMap extract: Central Silk Board junction, Bengaluru

`silkboard.osm` is the raw extract used to build `apps/web/public/data/silkboard.json`
(see `data-pipeline/src/weave_data/silkboard.py`). It is committed so the conversion can be
reproduced exactly.

## Attribution and licence
Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL) 1.0:
https://www.openstreetmap.org/copyright. `silkboard.json` is a derived database and is also
ODbL; any public use must credit "© OpenStreetMap contributors".

## Download
- **Date:** 2026-11-14 (Overpass `osm_base` timestamp `2026-11-14T10:53:33Z`).
- **Endpoint:** `https://overpass-api.de/api/interpreter` (HTTP POST, generic User-Agent).
- **Bounding box (S, W, N, E):** `12.9119, 77.6173, 12.9229, 77.6285`, about 1.21 km × 1.22 km
  centred on (12.9174 N, 77.6229 E): the Central Silk Board junction (Hosur Road × Outer Ring
  Road), its flyovers (Silk Board Flyover, the Ragigudda–Silk Board double-decker flyover and
  ramps) and roughly 600 m of each approach.
- **Query:** motor roads of class tertiary and above, with all their nodes:

```
[out:xml][timeout:90];
(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link)$"](12.9119,77.6173,12.9229,77.6285););
(._;>;);
out meta;
```

- **Size / checksum:** 176,144 bytes, 121 ways, 583 nodes;
  SHA-256 `c9d7a70978807eb7104e4f4beef616e51e39691c91bc5c09a6b0268a355d5c71`.

## Processing (summary)
1. Ways are clipped to the box (`weave_data.osm_clip`), because Overpass returns whole ways;
   cut runs shorter than 15 m are dropped. Junction-join fixes from
   `data-pipeline/patches/silkboard.json` fuse a few node groups first.
2. `netconvert` (eclipse-sumo 1.28) with `--lefthand`, joined junctions, guessed signals and
   internal lanes, projected with an equirectangular PROJ string around the box centre so
   coordinates are local metres. It runs twice: the second pass merges edges at geometry-only
   nodes (`--geometry.remove`) but protects every edge of a bridge/layer way and every edge
   touching one, so elevation tags never spread onto merged ground roads.
3. Conversion to the Weave network JSON (centrelines from lane shapes, left-edge lateral
   bands, movements, signal plans, zones). Layers come from OSM tags, not from netconvert's
   interpolated elevation: bridge/layer ways that pass over another road are structures at
   their layer; untagged ways touching a structure are ramps (upper layer, z profile); short
   tagged bridges that cross no road (over drains) keep their tagged layer at z = 0; every
   other way is layer 0.

## Known simplifications
- Residential and service roads are not in the extract.
- The flyover ramp `1301808820` ("Ramp to Hosur road joining Ragigudda Silkboard Double Decker
  Flyover") is removed: its approach is a lower-class road outside the extract, so it started
  at a dead end in mid-air. That approach to the double-decker is not modelled, and the
  double-decker link `1299932382` that only it fed is pruned as unreachable.
