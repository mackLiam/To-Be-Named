from __future__ import annotations

import re

from zells_pipeline.contract import (
    EXPECTED_PROPERTY_COUNT,
    MEASUREMENT_KEYS,
    SCHEMA,
    SCHEMA_VERSION,
    validate_measurements,
)

_SLICE_KEY_RE = re.compile(r"^S[1-4]_(ISW|ISD|ICW|ICD|OW|OD)$")


def realistic_payload() -> dict[str, float]:
    values = {"Leg_Length": 350.0}
    for slice_name in ("S1", "S2", "S3", "S4"):
        for dim in ("ISW", "ISD", "ICW", "ICD", "OW", "OD"):
            values[f"{slice_name}_{dim}"] = 80.0
    return values


def test_schema_loads_and_has_version() -> None:
    assert SCHEMA["properties"]
    assert SCHEMA_VERSION == SCHEMA["x-schema-version"]


def test_exactly_25_keys() -> None:
    assert len(MEASUREMENT_KEYS) == EXPECTED_PROPERTY_COUNT == 25


def test_keys_match_leg_length_and_slice_pattern() -> None:
    non_leg_keys = [k for k in MEASUREMENT_KEYS if k != "Leg_Length"]
    assert "Leg_Length" in MEASUREMENT_KEYS
    assert len(non_leg_keys) == 24
    for key in non_leg_keys:
        assert _SLICE_KEY_RE.match(key), f"{key} does not match the S<n>_<dim> pattern"


def test_accepts_realistic_payload() -> None:
    assert validate_measurements(realistic_payload()) == []


def test_rejects_out_of_range_leg_length() -> None:
    payload = realistic_payload()
    payload["Leg_Length"] = 1000.0  # schema max is 600
    violations = validate_measurements(payload)
    assert len(violations) == 1
    assert "Leg_Length" in violations[0]
    assert "600" in violations[0]


def test_rejects_out_of_range_slice_dim() -> None:
    payload = realistic_payload()
    payload["S2_ICD"] = 5.0  # schema min is 30
    violations = validate_measurements(payload)
    assert len(violations) == 1
    assert "S2_ICD" in violations[0]
    assert "30" in violations[0]


def test_reports_missing_key() -> None:
    payload = realistic_payload()
    del payload["S3_OW"]
    violations = validate_measurements(payload)
    assert any("S3_OW" in v and "missing" in v for v in violations)


def test_reports_unrecognized_key() -> None:
    payload = realistic_payload()
    payload["Not_A_Real_Key"] = 1.0
    violations = validate_measurements(payload)
    assert any("Not_A_Real_Key" in v for v in violations)


def test_reports_non_numeric_value() -> None:
    payload = realistic_payload()
    payload["Leg_Length"] = "not-a-number"
    violations = validate_measurements(payload)
    assert any("Leg_Length" in v and "number" in v for v in violations)
