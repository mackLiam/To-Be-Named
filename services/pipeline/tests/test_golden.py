"""Golden-file regression suite.

Compares extraction output against hand-verified (or, for the synthetic
case, analytically-derived) expected values for meshes checked into
`tests/fixtures/`. See `tests/fixtures/README.md` for the fixture-pair
convention and `docs/accuracy-log.md` for provenance/consent requirements on
any real-scan fixture.

If no fixture pairs exist, the module is reported as skipped rather than
silently contributing zero passing tests, so an empty golden suite cannot be
mistaken for a green one.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zells_pipeline.contract import MEASUREMENT_KEYS
from zells_pipeline.extraction.measure import extract_measurements
from zells_pipeline.extraction.mesh_loading import load_mesh

FIXTURES_DIR = Path(__file__).parent / "fixtures"
MESH_EXTENSIONS = (".obj", ".ply", ".glb")
EXPECTED_SUFFIX = ".expected.json"

# Suite-wide default per-key tolerance, used whenever a case's expected.json
# does not override a key in its "tolerances" object (see
# tests/fixtures/README.md): 2% relative or 1.0mm absolute, whichever is
# larger.
DEFAULT_TOLERANCE_PCT = 2.0
DEFAULT_TOLERANCE_ABS_MM = 1.0


def _find_mesh_for(name: str) -> Path | None:
    for ext in MESH_EXTENSIONS:
        candidate = FIXTURES_DIR / f"{name}{ext}"
        if candidate.is_file():
            return candidate
    return None


def _discover_golden_cases() -> list[tuple[str, Path, Path]]:
    if not FIXTURES_DIR.is_dir():
        return []
    cases = []
    for expected_path in sorted(FIXTURES_DIR.glob(f"*{EXPECTED_SUFFIX}")):
        name = expected_path.name[: -len(EXPECTED_SUFFIX)]
        mesh_path = _find_mesh_for(name)
        if mesh_path is not None:
            cases.append((name, mesh_path, expected_path))
    return cases


_GOLDEN_CASES = _discover_golden_cases()

if not _GOLDEN_CASES:
    pytest.skip(
        "No golden fixture pairs found in tests/fixtures/ (expected a "
        "<name>.expected.json alongside a matching <name>.obj/.ply/.glb). "
        "See tests/fixtures/README.md.",
        allow_module_level=True,
    )


def _tolerance_for(key: str, expected_value: float, overrides: dict) -> float:
    entry = overrides.get(key, {})
    pct = entry.get("pct", DEFAULT_TOLERANCE_PCT)
    abs_mm = entry.get("abs_mm", DEFAULT_TOLERANCE_ABS_MM)
    return max(abs(expected_value) * pct / 100.0, abs_mm)


@pytest.mark.parametrize(
    ("name", "mesh_path", "expected_path"),
    _GOLDEN_CASES,
    ids=[case[0] for case in _GOLDEN_CASES],
)
def test_golden_case_matches_expected(name: str, mesh_path: Path, expected_path: Path) -> None:
    expected = json.loads(expected_path.read_text())
    expected_values = expected["values"]
    overrides = expected.get("tolerances", {})

    missing_keys = set(MEASUREMENT_KEYS) - expected_values.keys()
    assert not missing_keys, f"{expected_path} is missing keys: {sorted(missing_keys)}"

    mesh = load_mesh(mesh_path)
    result = extract_measurements(mesh)

    assert set(result.values.keys()) == set(MEASUREMENT_KEYS)

    mismatches = []
    for key in MEASUREMENT_KEYS:
        expected_value = expected_values[key]
        actual_value = result.values[key]
        tolerance = _tolerance_for(key, expected_value, overrides)
        if abs(actual_value - expected_value) > tolerance:
            mismatches.append(
                f"{key}: expected {expected_value:.2f}mm, got {actual_value:.2f}mm "
                f"(tolerance {tolerance:.2f}mm)"
            )

    assert not mismatches, "\n".join(mismatches)
