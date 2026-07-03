"""CLI: run the extraction pipeline against a single mesh file.

Purpose (docs/ROADMAP.md week 2-3): once real leg scans start arriving as
OBJ files, this gives a one-command way to load a mesh, run the same
`load_mesh` -> `extract_measurements` -> `validate_measurements` path the
worker uses, and see the 25 values plus gate results without touching the
job queue. `--json` output is also the format golden-file expected fixtures
are built from (see `scripts/make_synthetic_fixture.py` and
`tests/fixtures/README.md`).

Usage:
    python -m zells_pipeline.extract <mesh-path> [--json]
    zells-extract <mesh-path> [--json]

Exit codes:
    0  mesh loaded, measured, and every plausibility gate passed
    1  the mesh could not be loaded or measured (bad input; see stderr)
    2  the mesh was measured but one or more plausibility gates failed
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from zells_pipeline.contract import MEASUREMENT_KEYS, SCHEMA_VERSION, validate_measurements
from zells_pipeline.extraction.measure import (
    EXTRACTION_VERSION,
    MeasurementError,
    extract_measurements,
)
from zells_pipeline.extraction.mesh_loading import MeshValidationError, load_mesh

EXIT_OK = 0
EXIT_LOAD_OR_MEASURE_ERROR = 1
EXIT_GATES_FAILED = 2

_NAME_WIDTH = max(len(key) for key in MEASUREMENT_KEYS)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zells-extract",
        description=(
            "Load a mesh, run the Zells measurement extraction algorithm, and print the "
            "25-variable values plus plausibility-gate results."
        ),
    )
    parser.add_argument(
        "mesh_path",
        type=Path,
        help="Path to a mesh file (.obj, .ply, .glb, .usdz).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of a human-readable table.",
    )
    return parser


def _failures_by_key(violations: list[str]) -> dict[str, str]:
    """Map each violated key to its full violation message.

    Every string `validate_measurements` returns is formatted as
    "{key}: message" (see contract.py), so splitting on the first ": "
    recovers the key a given failure belongs to.
    """
    failures: dict[str, str] = {}
    for violation in violations:
        key, _, _ = violation.partition(": ")
        failures[key] = violation
    return failures


def _format_table(
    values: dict[str, float],
    needs_scale_confirmation: bool,
    violations: list[str],
) -> str:
    lines: list[str] = []
    for key in MEASUREMENT_KEYS:
        value = values.get(key)
        value_str = f"{value:10.2f} mm" if isinstance(value, int | float) else "     MISSING"
        lines.append(f"{key.ljust(_NAME_WIDTH)}  {value_str}")

    lines.append("")
    lines.append(f"extraction_version: {EXTRACTION_VERSION}")
    lines.append(f"schema_version: {SCHEMA_VERSION}")
    lines.append(f"needs_scale_confirmation: {needs_scale_confirmation}")
    lines.append("")

    failures = _failures_by_key(violations)
    gates_passed = not violations
    header = "Gates: PASS" if gates_passed else f"Gates: FAIL ({len(violations)} failure(s))"
    lines.append(header)
    for key in MEASUREMENT_KEYS:
        if key in failures:
            lines.append(f"  FAIL  {key.ljust(_NAME_WIDTH)}  {failures[key]}")
        else:
            lines.append(f"  PASS  {key.ljust(_NAME_WIDTH)}")
    # Defensive: an unrecognized/extra key can only appear if extraction ever
    # regresses to returning something outside the 25-variable contract.
    for key, message in failures.items():
        if key not in MEASUREMENT_KEYS:
            lines.append(f"  FAIL  {key}  {message}")

    return "\n".join(lines)


def _build_json_payload(
    values: dict[str, float],
    needs_scale_confirmation: bool,
    violations: list[str],
) -> dict:
    return {
        "values": values,
        "extraction_version": EXTRACTION_VERSION,
        "schema_version": SCHEMA_VERSION,
        "needs_scale_confirmation": needs_scale_confirmation,
        "gates": {"passed": not violations, "failures": violations},
    }


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        mesh = load_mesh(args.mesh_path)
        result = extract_measurements(mesh)
    except (MeshValidationError, MeasurementError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_LOAD_OR_MEASURE_ERROR

    violations = validate_measurements(result.values)

    if args.json:
        payload = _build_json_payload(result.values, result.needs_scale_confirmation, violations)
        print(json.dumps(payload, indent=2))
    else:
        print(_format_table(result.values, result.needs_scale_confirmation, violations))

    return EXIT_OK if not violations else EXIT_GATES_FAILED


def run() -> None:
    """Console-script entry point (`zells-extract`). See `main` for the testable core."""
    raise SystemExit(main())


if __name__ == "__main__":
    raise SystemExit(main())
