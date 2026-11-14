"""Synthetic frames shaped like the Chennai files (12 columns, 0.5 s step), for tests that must
run before the real data exist. Nothing here is fitted to, or copied from, the real data."""

from __future__ import annotations

import numpy as np
import pandas as pd

from weave_data.chennai_io import COLUMNS

HEADER = ["Vehicle number", "Vehicle type", "Time (sec)", "Vehicle length (m)",
          "Vehicle width (m)", "Longitudinal position of the front (m)",
          "Longitudinal speed (m/s)", "Longitudinal acceleration (m/s2)",
          "Lateral position of the centre (m)", "Lateral speed (m/s)",
          "Lateral acceleration (m/s2)", "Flag"]

SIZES = {1: (1.9, 0.7), 2: (4.2, 1.7), 3: (11.0, 2.5), 4: (8.5, 2.4), 5: (5.2, 1.9), 6: (2.8, 1.4)}


def raw_frame(rows: list[list[float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=COLUMNS)


def write_xlsx(df: pd.DataFrame, path, header: bool = True) -> None:
    out = df.copy()
    if header:
        out.columns = HEADER
        out.to_excel(path, index=False, engine="openpyxl")
    else:
        out.to_excel(path, index=False, header=False, engine="openpyxl")


def traffic(seed: int, duration_s: float = 300.0, headway_s: float = 0.6, section_m: float = 250.0,
            road_w: float = 11.0, column_factor: float = 1.92, flag_rate: float = 0.02) -> pd.DataFrame:
    """Free-flowing multi-class traffic. Each vehicle drives at its own speed with a small
    sinusoidal acceleration, at a fixed lateral position; tracking starts in the first 10 m and
    ends in the last 10 m. The speed/acceleration columns are the true values divided by
    `column_factor` (mimicking the dataset's defect)."""
    rng = np.random.default_rng(seed)
    types = rng.choice([1, 2, 3, 4, 5, 6], p=[0.5, 0.2, 0.05, 0.05, 0.05, 0.15],
                       size=int(duration_s / headway_s))
    rows = []
    grid = np.arange(0, duration_s + 60.0, 0.5)
    for vid, ty in enumerate(types, start=1):
        t0 = vid * headway_s
        v = rng.uniform(9.0, 13.0)
        A, w, ph = rng.uniform(0.0, 0.5), rng.uniform(0.2, 0.6), rng.uniform(0, 2 * np.pi)
        L, W = SIZES[int(ty)]
        if ty in (2, 3, 4, 5):  # size varies for these classes, fixed for 1 and 6
            L *= rng.uniform(0.9, 1.1)
            W = min(2.6, W * rng.uniform(0.95, 1.05))
        y0 = rng.uniform(W / 2 + 0.2, road_w - W / 2 - 0.2)
        x_start, x_end = rng.uniform(0, 10), rng.uniform(section_m - 10, section_m)
        tt = grid[grid >= t0]
        tau = tt - t0
        x = v * tau + A / w**2 * (np.sin(ph) + w * tau * np.cos(ph) - np.sin(w * tau + ph))
        vel = v + A / w * (np.cos(ph) - np.cos(w * tau + ph))
        acc = A * np.sin(w * tau + ph)
        m = (x >= x_start) & (x <= x_end)
        for ti, xi, vi, ai in zip(tt[m], x[m], vel[m], acc[m]):
            flag = int(rng.integers(1, 8)) if rng.random() < flag_rate else 0
            rows.append([vid, int(ty), ti, round(L, 3), round(W, 3), xi, vi / column_factor,
                         ai / column_factor, y0, 0.0, 0.0, flag])
    return raw_frame(rows)
