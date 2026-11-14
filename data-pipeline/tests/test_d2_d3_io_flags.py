"""D2 (class mapping and units) and D3 (flag filtering) on synthetic frames shaped like the
Chennai files. Class codes and column order come from the dataset legend
(1 motorcycle, 2 car, 3 bus, 4 truck, 5 LCV, 6 auto-rickshaw)."""

import numpy as np
import pandas as pd
import pytest

from synth import raw_frame, write_xlsx
from weave_data import chennai_io as cio
from weave_data.kinematics import A_WINDOW, add_kinematics, fit_rows


def small_frame(flags=None) -> pd.DataFrame:
    rows = []
    for vid, ty in enumerate([1, 2, 3, 4, 5, 6], start=1):
        for k in range(20):
            t = 10.0 + 0.5 * k
            rows.append([vid, ty, t, 4.0, 1.5, 5.0 + 10.0 * 0.5 * k, 5.0, 0.0, 2.0 + vid, 0.0, 0.0,
                         0 if flags is None else flags(vid, k)])
    return raw_frame(rows)


# ---------------------------------------------------------------------------------- D2

def test_legend_class_mapping():
    assert cio.CLASS_BY_CODE == {1: "motorcycle", 2: "car", 3: "bus", 4: "truck", 5: "lcv", 6: "auto"}


def test_xlsx_roundtrip_with_header_block(tmp_path):
    p = tmp_path / "f.xlsx"
    write_xlsx(small_frame(), p, header=True)
    raw, header = cio.read_raw(p)
    assert list(raw.columns) == cio.COLUMNS
    assert "Vehicle type" in header[1] and "Flag" in header[11]
    df = cio.normalise(raw, "A")
    assert df.groupby("vid")["cls"].first().to_dict() == {
        1: "motorcycle", 2: "car", 3: "bus", 4: "truck", 5: "lcv", 6: "auto"}
    assert df["key"].nunique() == 6 and (df["file"] == "A").all()
    facts = cio.check_units(df)
    assert facts["median_dt_s"] == 0.5
    assert facts["vehicles"] == 6


def test_xlsx_without_header(tmp_path):
    p = tmp_path / "f.xlsx"
    write_xlsx(small_frame(), p, header=False)
    raw, _ = cio.read_raw(p)
    assert len(raw) == 6 * 20


def test_unknown_class_code_rejected():
    raw = small_frame()
    raw.loc[0, "type"] = 7
    with pytest.raises(cio.DataFormatError):
        cio.normalise(raw, "A")


@pytest.mark.parametrize("col,factor", [("width", 100.0), ("length", 100.0)])
def test_sizes_in_centimetres_rejected(col, factor):
    raw = small_frame()
    raw[col] *= factor
    with pytest.raises(cio.DataFormatError):
        cio.check_units(cio.normalise(raw, "A"))


def test_time_in_wrong_unit_rejected():
    raw = small_frame()
    raw["t"] *= 1000.0  # milliseconds
    with pytest.raises(cio.DataFormatError):
        cio.check_units(cio.normalise(raw, "A"))


def test_vehicle_ids_unique_per_file():
    a = cio.normalise(small_frame(), "A")
    b = cio.normalise(small_frame(), "B")
    assert set(a["key"]).isdisjoint(set(b["key"]))


# ---------------------------------------------------------------------------------- D3

def test_clean_rows_drop_every_nonzero_flag():
    raw = small_frame(flags=lambda vid, k: (vid + k) % 8)
    df = cio.normalise(raw, "A")
    clean = cio.clean_rows(df)
    assert (clean["flag"] == 0).all()
    assert len(clean) == int((df["flag"] == 0).sum())
    assert set(df["flag"].unique()) == set(range(8))


def test_flag_out_of_range_rejected():
    raw = small_frame()
    raw.loc[3, "flag"] = 8
    with pytest.raises(cio.DataFormatError):
        cio.normalise(raw, "A")


def test_fit_rows_exclude_whole_window_around_flagged_rows():
    # vehicle 2 has one flagged row with a corrupted position; every sample whose
    # acceleration window contains that row must be excluded, and the rest must equal the
    # values of the uncorrupted trajectory.
    def flags(vid, k):
        return 3 if (vid == 2 and k == 10) else 0
    raw = small_frame(flags)
    raw.loc[(raw["vid"] == 2) & (raw["flag"] == 3), "x"] += 25.0
    df = add_kinematics(cio.normalise(raw, "A"))
    fr = fit_rows(df)
    v2 = fr[fr["vid"] == 2]
    h = A_WINDOW // 2
    t_bad = 10.0 + 0.5 * 10
    assert (np.abs(v2["t"] - t_bad) > h * 0.5 + 1e-9).all()
    assert np.allclose(v2["v"], 10.0, atol=1e-9) and np.allclose(v2["a"], 0.0, atol=1e-9)
    # vehicles without flags keep all their samples
    assert len(fr[fr["vid"] == 1]) == 20
