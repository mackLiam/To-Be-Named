"""forms.leg-model v1 and forms.measurement-quality v1 (docs/ESTIMATOR-V1.md 1 and 2).

Mirrors packages/shared/src/legModel.ts and quality.ts; the two validators are
one logical artifact and change in the same commit. The measurement keys and
the Leg_Length range come from forms_pipeline.contract and are never restated.

Failures raise LegModelError / MeasurementQualityError, non-retriable: the same
document can never succeed. Messages name fields and error types, never
values (a scan-derived ring must not reach logs).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import (
    AllowInfNan,
    BaseModel,
    ConfigDict,
    Field,
    Strict,
    ValidationError,
    model_validator,
)

from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA

LEG_MODEL_FORMAT = "forms.leg-model"
LEG_MODEL_VERSION = 1
LEG_MODEL_FRAME = "x_right_y_anterior_z_up"
LEG_MODEL_RING_COUNT = 21
LEG_MODEL_RING_POINTS = 48
FIT_CHECKS = ("none", "optional", "required")
FIT_ACTION_KINDS = ("tape", "stature")

MEASUREMENT_QUALITY_FORMAT = "forms.measurement-quality"
MEASUREMENT_QUALITY_VERSION = 1
VALUE_SOURCES = ("observed", "inferred", "manual", "adjusted")

_COORD_LIMIT_MM = 300.0
_T_TOLERANCE = 1e-6
_SIGMA_MAX_MM = 1000.0
_SEMVER = r"^\d+\.\d+\.\d+$"

_LEG_LENGTH_SPEC = SCHEMA["properties"]["Leg_Length"]
_LEG_LENGTH_MIN: float = _LEG_LENGTH_SPEC["minimum"]
_LEG_LENGTH_MAX: float = _LEG_LENGTH_SPEC["maximum"]

FIT_CRITICAL_KEYS = tuple(
    k for k in MEASUREMENT_KEYS if k == "Leg_Length" or k.endswith(("_OW", "_OD"))
)

# Strict rejects bools and numeric strings; AllowInfNan(False) rejects nan/inf.
Number = Annotated[float, Strict(), AllowInfNan(False)]
Coord = Annotated[
    float, Strict(), AllowInfNan(False), Field(ge=-_COORD_LIMIT_MM, le=_COORD_LIMIT_MM)
]
XY = Annotated[list[Coord], Field(min_length=2, max_length=2)]


class LegModelError(ValueError):
    """Non-retriable failure: the leg-model document is malformed."""


class MeasurementQualityError(ValueError):
    """Non-retriable failure: the measurement-quality document is malformed."""


def _describe(exc: ValidationError) -> str:
    # Never pydantic's own text: it embeds the offending input. Our validators'
    # value_error messages are value-free and name the field themselves.
    parts: set[str] = set()
    for e in exc.errors():
        if e["type"] == "value_error":
            parts.add(str(e["msg"]).removeprefix("Value error, "))
        else:
            parts.add(f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['type']}")
    return "; ".join(sorted(parts))


class FitAction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["tape", "stature"]
    key: str | None = None

    @model_validator(mode="after")
    def _check_key(self) -> FitAction:
        if self.kind == "stature":
            if self.key is not None:
                raise ValueError("key: not allowed for kind stature")
        elif self.key not in FIT_CRITICAL_KEYS:
            raise ValueError("key: must be a fit-critical measurement key")
        return self


class Ring(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    t: Number
    center: XY
    crest: XY
    points: Annotated[
        list[XY], Field(min_length=LEG_MODEL_RING_POINTS, max_length=LEG_MODEL_RING_POINTS)
    ]

    @model_validator(mode="after")
    def _counter_clockwise(self) -> Ring:
        pts = self.points
        area2 = sum(
            pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
            for i in range(len(pts))
        )
        if area2 <= 0:
            raise ValueError("points: ring must be counter-clockwise seen from +z")
        return self


class LegModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    format: Literal["forms.leg-model"]
    version: Annotated[int, Strict()]
    leg: Literal["L", "R"]
    units: Literal["mm"]
    frame: Literal["x_right_y_anterior_z_up"]
    estimator_version: str = Field(pattern=_SEMVER)
    prior_version: str = Field(pattern=_SEMVER)
    leg_length_mm: Number
    rings: Annotated[
        list[Ring], Field(min_length=LEG_MODEL_RING_COUNT, max_length=LEG_MODEL_RING_COUNT)
    ]
    fit_check: Literal["none", "optional", "required"]
    # Required key; null if and only if fit_check is "none".
    fit_action: FitAction | None

    @model_validator(mode="after")
    def _cross_field(self) -> LegModel:
        if self.version != LEG_MODEL_VERSION:
            raise ValueError("version: expected 1")
        if not _LEG_LENGTH_MIN <= self.leg_length_mm <= _LEG_LENGTH_MAX:
            raise ValueError("leg_length_mm: outside the Leg_Length schema range")
        for k, ring in enumerate(self.rings):
            if abs(ring.t - k / (LEG_MODEL_RING_COUNT - 1)) > _T_TOLERANCE:
                raise ValueError("rings.t: not on the k/20 grid")
        if (self.fit_action is None) != (self.fit_check == "none"):
            raise ValueError("fit_action: null if and only if fit_check is none")
        return self


def parse_leg_model(data: dict[str, Any]) -> LegModel:
    """Parse a leg-model document, raising LegModelError on any violation."""
    try:
        return LegModel.model_validate(data)
    except ValidationError as exc:
        raise LegModelError(f"invalid leg model: {_describe(exc)}") from exc


class QualityValue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source: Literal["observed", "inferred", "manual", "adjusted"]
    sigma_mm: Annotated[float, Strict(), AllowInfNan(False), Field(gt=0, le=_SIGMA_MAX_MM)]


class MeasurementQuality(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    format: Literal["forms.measurement-quality"]
    version: Annotated[int, Strict()]
    values: dict[str, QualityValue]
    verdict: Literal["none", "optional", "required"]
    worst_ratio: Annotated[float, Strict(), AllowInfNan(False), Field(ge=0)]
    worst_key: str | None
    tolerances_mm: dict[str, Annotated[float, Strict(), AllowInfNan(False), Field(gt=0)]]
    # Required key; null if and only if verdict is "none".
    action: FitAction | None

    @model_validator(mode="after")
    def _cross_field(self) -> MeasurementQuality:
        if self.version != MEASUREMENT_QUALITY_VERSION:
            raise ValueError("version: expected 1")
        if set(self.values) != set(MEASUREMENT_KEYS):
            raise ValueError("values: keys must be exactly the measurement keys")
        if not set(self.tolerances_mm) <= set(MEASUREMENT_KEYS):
            raise ValueError("tolerances_mm: keys must be measurement keys")
        if self.worst_ratio == 0:
            if self.worst_key is not None:
                raise ValueError("worst_key: must be null when worst_ratio is 0")
        elif self.worst_key not in FIT_CRITICAL_KEYS:
            raise ValueError("worst_key: must be a fit-critical key when worst_ratio > 0")
        if (self.action is None) != (self.verdict == "none"):
            raise ValueError("action: null if and only if verdict is none")
        return self


def parse_measurement_quality(data: dict[str, Any]) -> MeasurementQuality:
    """Parse a measurement-quality document, raising MeasurementQualityError on any violation."""
    try:
        return MeasurementQuality.model_validate(data)
    except ValidationError as exc:
        raise MeasurementQualityError(f"invalid measurement quality: {_describe(exc)}") from exc


__all__ = [
    "FIT_ACTION_KINDS",
    "FIT_CHECKS",
    "FitAction",
    "LegModel",
    "LegModelError",
    "MeasurementQuality",
    "MeasurementQualityError",
    "QualityValue",
    "Ring",
    "VALUE_SOURCES",
    "parse_leg_model",
    "parse_measurement_quality",
]
