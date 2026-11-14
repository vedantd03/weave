"""Loading the Chennai mixed-traffic trajectory files (Kanagaraj et al., 2015).

Each file is one worksheet of rows, one row per vehicle per 0.5 s, with 12 columns in this
order (dataset legend):

    1 vehicle number            7 longitudinal speed (m/s)        [NOT USED: ~1.9x too low]
    2 vehicle type 1..6         8 longitudinal acceleration       [NOT USED]
    3 time (s), 0.5 s step      9 lateral position of the CENTRE (m) from the left-most side
    4 vehicle length (m)       10 lateral speed                    [NOT USED]
    5 vehicle width (m)        11 lateral acceleration             [NOT USED]
    6 longitudinal position of the FRONT (m) from the upstream end
                               12 flag 0..7 (0 = clean)

Vehicle types: 1 motorcycle, 2 car, 3 bus, 4 truck, 5 LCV, 6 auto-rickshaw.

Columns are mapped by position, after locating the first data row (a header block, if any,
is skipped). The reported speed/acceleration columns are kept only under `*_col` names, for
the D6 ratio check; nothing is fitted to them.
"""

from __future__ import annotations

import hashlib
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from . import RAW_CHENNAI, REPO_ROOT

FILES = {
    "2.45-3.00": "ChennaiTrajectoryData2.45-3.00PM.xlsx",
    "3.00-3.15": "ChennaiTrajectoryData3.00-3.15PM.xlsx",
}

COLUMNS = ["vid", "type", "t", "length", "width", "x", "v_col", "a_col",
           "y", "vy_col", "ay_col", "flag"]

CLASS_BY_CODE = {1: "motorcycle", 2: "car", 3: "bus", 4: "truck", 5: "lcv", 6: "auto"}
CLASS_LABEL = {"motorcycle": "Motorcycle", "car": "Car", "bus": "Bus", "truck": "Truck",
               "lcv": "Light commercial vehicle", "auto": "Auto-rickshaw"}
DT_S = 0.5
FLAG_VALUES = set(range(8))

CACHE_DIR = REPO_ROOT / "data-pipeline" / "build" / "cache"


class DataFormatError(ValueError):
    pass


def available_files() -> dict[str, Path]:
    return {k: RAW_CHENNAI / v for k, v in FILES.items() if (RAW_CHENNAI / v).exists()}


def missing_reason() -> str | None:
    missing = [v for v in FILES.values() if not (RAW_CHENNAI / v).exists()]
    if missing:
        return (f"Chennai trajectory files not present in {RAW_CHENNAI} (missing: "
                f"{', '.join(missing)}); the user provides them, they are never downloaded")
    return None


def _first_data_row(raw: pd.DataFrame) -> int:
    for i in range(min(len(raw), 200)):
        row = pd.to_numeric(raw.iloc[i, :12], errors="coerce")
        if row.notna().sum() >= 12:
            return i
    raise DataFormatError("no row with 12 numeric cells in the first 200 rows")


def read_raw(path: Path) -> tuple[pd.DataFrame, list[str]]:
    """Read the worksheet with the most rows; return (12 canonical columns, header text)."""
    sheets = pd.read_excel(path, sheet_name=None, header=None, engine="openpyxl")
    name, raw = max(sheets.items(), key=lambda kv: len(kv[1]))
    if raw.shape[1] < 12:
        raise DataFormatError(f"{path.name}/{name}: {raw.shape[1]} columns, expected 12")
    i0 = _first_data_row(raw)
    header = [" ".join(str(v) for v in raw.iloc[:i0, j].dropna()) for j in range(12)]
    df = raw.iloc[i0:, :12].apply(pd.to_numeric, errors="coerce")
    df.columns = COLUMNS
    df = df.dropna(how="all")
    if df.isna().any().any():
        bad = int(df.isna().any(axis=1).sum())
        raise DataFormatError(f"{path.name}: {bad} rows with non-numeric cells")
    return df.reset_index(drop=True), header


def normalise(df: pd.DataFrame, file_key: str) -> pd.DataFrame:
    """Types, class ids, a per-file unique vehicle key; sorted by (vehicle, time)."""
    df = df.copy()
    df["vid"] = df["vid"].astype(np.int64)
    df["type"] = df["type"].astype(np.int64)
    df["flag"] = df["flag"].astype(np.int64)
    unknown = sorted(set(df["type"].unique()) - set(CLASS_BY_CODE))
    if unknown:
        raise DataFormatError(f"unknown vehicle type codes {unknown}")
    bad_flags = sorted(set(df["flag"].unique()) - FLAG_VALUES)
    if bad_flags:
        raise DataFormatError(f"flag values outside 0..7: {bad_flags}")
    df["cls"] = df["type"].map(CLASS_BY_CODE)
    df["file"] = file_key
    df["key"] = file_key + ":" + df["vid"].astype(str)
    return df.sort_values(["key", "t"]).reset_index(drop=True)


def check_units(df: pd.DataFrame) -> dict:
    """Unit/consistency checks (D2). Raises DataFormatError on violation; returns facts.

    These are unit-plausibility bounds (catching cm-for-m or ms-for-s mistakes), not filters
    on measurements: no road vehicle is wider than 4 m or longer than 20 m (the Indian Central
    Motor Vehicles Rules limit width to 2.6 m and length to 18 m; video-measured widths can
    exceed 2.6 m through mirrors and measurement error, so those vehicles are counted and kept);
    positions must be non-negative; the time step must be the dataset's 0.5 s.
    """
    facts: dict = {}
    dts = df.groupby("key")["t"].diff().dropna()
    if len(dts):
        step = float(np.median(dts))
        facts["median_dt_s"] = step
        if abs(step - DT_S) > 1e-6:
            raise DataFormatError(f"median time step {step} s, expected {DT_S} s")
        facts["gap_fraction"] = float((dts > DT_S + 1e-6).mean())
        if (dts <= 0).any():
            raise DataFormatError("non-increasing time within a vehicle")
    if (df["width"] <= 0).any() or (df["length"] <= 0).any():
        raise DataFormatError("non-positive vehicle size")
    if df["width"].max() > 4.0:
        raise DataFormatError(f"vehicle width {df['width'].max()} m > 4 m (not metres?)")
    wide = df.groupby("key").agg(w=("width", "first"), cls=("cls", "first"))
    facts["vehicles_wider_than_2p6m"] = {str(k): int(v) for k, v in
                                         wide[wide["w"] > 2.6]["cls"].value_counts().items()}
    if df["length"].max() > 20.0:
        raise DataFormatError(f"vehicle length {df['length'].max()} m > 20 m (not metres?)")
    if (df["y"] < -1.0).any():
        raise DataFormatError("lateral centre position below −1 m")
    # sizes are per-vehicle constants
    per_veh = df.groupby("key")[["length", "width", "type"]].nunique()
    facts["vehicles_with_varying_size"] = int((per_veh[["length", "width"]] > 1).any(axis=1).sum())
    facts["vehicles_with_varying_type"] = int((per_veh["type"] > 1).sum())
    if facts["vehicles_with_varying_type"]:
        raise DataFormatError("vehicle type changes within a trajectory")
    facts["x_range_m"] = [float(df["x"].min()), float(df["x"].max())]
    facts["y_range_m"] = [float(df["y"].min()), float(df["y"].max())]
    facts["rows"] = int(len(df))
    facts["vehicles"] = int(df["key"].nunique())
    return facts


def clean_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows usable for microscopic fits: flag == 0 (D3)."""
    return df[df["flag"] == 0]


def load(file_key: str, path: Path | None = None, use_cache: bool = True) -> pd.DataFrame:
    path = path or RAW_CHENNAI / FILES[file_key]
    st = path.stat()
    tag = hashlib.sha1(f"{path.resolve()}:{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()[:16]
    cache = CACHE_DIR / f"{file_key}-{tag}.pkl"
    if use_cache and cache.exists():
        with cache.open("rb") as fh:
            return pickle.load(fh)
    raw, _ = read_raw(path)
    df = normalise(raw, file_key)
    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with cache.open("wb") as fh:
            pickle.dump(df, fh)
    return df
