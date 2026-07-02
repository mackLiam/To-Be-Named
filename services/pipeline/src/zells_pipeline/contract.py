"""The frozen 25-variable measurement contract.

Single source of truth is the shared JSON Schema at
`packages/shared/schema/measurements.schema.json` (see docs/DESIGN.md gotcha
#2). This module loads it once at import time, fails loudly if the schema is
missing or malformed, and exposes:

- `MEASUREMENT_KEYS`: the exact 25 property names, in schema order.
- `SCHEMA_VERSION`: the `x-schema-version` string.
- `validate_measurements`: the plausibility gates from docs/DESIGN.md gotcha
  #7, driven entirely by the schema's `minimum`/`maximum` bounds so the
  ranges never drift out of sync with the schema file.

As of writing the schema itself is DRAFT (see its `$comment`): names and
ranges are pending confirmation with the CAD collaborator. This module does
not encode that uncertainty further; it just enforces whatever the schema
currently says.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from zells_pipeline.config import get_settings

EXPECTED_PROPERTY_COUNT = 25


class ContractError(RuntimeError):
    """Raised when the measurement schema is missing or malformed."""


def _load_schema(schema_path: Path) -> dict[str, Any]:
    if not schema_path.is_file():
        raise ContractError(
            f"Measurement schema not found at {schema_path}. Set SCHEMA_PATH or check that "
            "packages/shared/schema/measurements.schema.json exists."
        )
    try:
        with schema_path.open(encoding="utf-8") as f:
            schema = json.load(f)
    except json.JSONDecodeError as exc:
        raise ContractError(
            f"Measurement schema at {schema_path} is not valid JSON: {exc}"
        ) from exc

    properties = schema.get("properties")
    if not isinstance(properties, dict) or len(properties) != EXPECTED_PROPERTY_COUNT:
        count = len(properties) if isinstance(properties, dict) else 0
        raise ContractError(
            f"Measurement schema at {schema_path} must define exactly "
            f"{EXPECTED_PROPERTY_COUNT} properties, found {count}."
        )
    if "x-schema-version" not in schema:
        raise ContractError(f"Measurement schema at {schema_path} is missing x-schema-version.")
    return schema


_SETTINGS = get_settings()
SCHEMA: dict[str, Any] = _load_schema(_SETTINGS.schema_path)
SCHEMA_PATH: Path = _SETTINGS.schema_path
SCHEMA_VERSION: str = SCHEMA["x-schema-version"]
MEASUREMENT_KEYS: tuple[str, ...] = tuple(SCHEMA["properties"].keys())
REQUIRED_KEYS: frozenset[str] = frozenset(SCHEMA.get("required", MEASUREMENT_KEYS))


def validate_measurements(values: dict[str, Any]) -> list[str]:
    """Check `values` against the schema's plausibility gates.

    Returns a list of human-readable violation strings (empty means the
    payload passes every gate). This is deliberately not a hard
    jsonschema.validate() call with a single exception: callers (the measure
    step) want every violation, not just the first, so they can log/report
    all of them and produce a single user-facing "please rescan" reason.
    """
    violations: list[str] = []

    missing = REQUIRED_KEYS - values.keys()
    for key in sorted(missing):
        violations.append(f"{key}: missing required measurement")

    extra = values.keys() - set(MEASUREMENT_KEYS)
    for key in sorted(extra):
        violations.append(f"{key}: not a recognized measurement (not in the 25-variable schema)")

    for key, spec in SCHEMA["properties"].items():
        if key not in values:
            continue
        value = values[key]
        if not isinstance(value, int | float) or isinstance(value, bool):
            violations.append(f"{key}: expected a number, got {type(value).__name__}")
            continue

        minimum = spec.get("minimum")
        maximum = spec.get("maximum")
        if minimum is not None and value < minimum:
            violations.append(
                f"{key}: {value:g}mm is below the plausible minimum of {minimum:g}mm "
                f"(allowed range {minimum:g}-{maximum:g}mm)"
            )
        elif maximum is not None and value > maximum:
            violations.append(
                f"{key}: {value:g}mm is above the plausible maximum of {maximum:g}mm "
                f"(allowed range {minimum:g}-{maximum:g}mm)"
            )

    return violations
