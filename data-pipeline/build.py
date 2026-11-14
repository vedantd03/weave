"""Run the whole pipeline: `uv run python build.py` (see src/weave_data/build.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from weave_data.build import main  # noqa: E402

raise SystemExit(main())
