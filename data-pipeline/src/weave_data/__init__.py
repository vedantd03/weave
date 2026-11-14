"""Weave offline data pipeline."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "docs" / "schema"
OUT_DIR = REPO_ROOT / "apps" / "web" / "public" / "data"
RAW_CHENNAI = REPO_ROOT / "data" / "chennai"
RAW_OSM = REPO_ROOT / "data" / "osm"
