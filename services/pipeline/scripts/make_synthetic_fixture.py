"""Generate the synthetic-frustum golden fixture (mesh + expected.json).

Reuses the same tapered-frustum builder and constants as `tests/conftest.py`
(imported from there, not copied) so the golden mesh is exactly the shape
already exercised by `tests/test_measure.py`'s analytic-ellipse assertions.
The expected values are produced by running the real extraction, never
hand-typed (see `tests/fixtures/README.md`).

Run from `services/pipeline` with:
    .venv/bin/python scripts/make_synthetic_fixture.py

Re-run this whenever the frustum's constructed dimensions in
`tests/conftest.py` change, and check the regenerated files in.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_PIPELINE_ROOT = Path(__file__).resolve().parents[1]
_SRC_DIR = _PIPELINE_ROOT / "src"
_TESTS_DIR = _PIPELINE_ROOT / "tests"
for _path in (_SRC_DIR, _TESTS_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from conftest import (  # noqa: E402 - path setup above must run first
    FRUSTUM_HEIGHT_MM,
    FRUSTUM_NARROW_RX_MM,
    FRUSTUM_NARROW_RY_MM,
    FRUSTUM_WIDE_RX_MM,
    FRUSTUM_WIDE_RY_MM,
    make_tapered_frustum,
)

from zells_pipeline.contract import validate_measurements  # noqa: E402
from zells_pipeline.extraction.measure import extract_measurements  # noqa: E402

FIXTURES_DIR = _TESTS_DIR / "fixtures"
FIXTURE_NAME = "synthetic-frustum"


def main() -> None:
    mesh = make_tapered_frustum(
        FRUSTUM_HEIGHT_MM,
        FRUSTUM_WIDE_RX_MM,
        FRUSTUM_WIDE_RY_MM,
        FRUSTUM_NARROW_RX_MM,
        FRUSTUM_NARROW_RY_MM,
    )
    result = extract_measurements(mesh)

    violations = validate_measurements(result.values)
    if violations:
        raise SystemExit(
            "Synthetic fixture fails its own plausibility gates; adjust the frustum "
            "dimensions in tests/conftest.py:\n" + "\n".join(violations)
        )

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    mesh_path = FIXTURES_DIR / f"{FIXTURE_NAME}.obj"
    mesh.export(mesh_path)

    expected_path = FIXTURES_DIR / f"{FIXTURE_NAME}.expected.json"
    expected_path.write_text(json.dumps({"values": result.values}, indent=2, sort_keys=True) + "\n")

    print(f"wrote {mesh_path}")
    print(f"wrote {expected_path}")


if __name__ == "__main__":
    main()
