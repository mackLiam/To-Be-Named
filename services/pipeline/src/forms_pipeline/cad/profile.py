"""Leg measurements to CAD model values: the one conversion boundary.

The 25 values the pipeline stores are LEG measurements (schema 1.1.0). The
Onshape model's variables with the same names are a different quantity: per
slice, an open spline through four points in the slice plane, measured from
the shin crest at (0, 0): inner calf (-ICW, -ICD), inner shin (-ISW, -ISD),
crest (0, 0), outer (+OW, -OD). Widths are how far the guard reaches round
each side of the crest; depths are how far back the leg surface falls away
there (docs/DESIGN.md 12.2). Sending leg values straight to the model builds
a guard that wraps almost to the calf, so every CAD job passes through
`apply_profile` exactly once, in CadDispatcher.generate.

Millimeters in, millimeters out. The provider still owns the one mm to
native-unit conversion; nothing here converts units.
"""

from __future__ import annotations

import math
from collections.abc import Mapping

from forms_pipeline.cad.model import CrestSplineV1Profile, IdentityProfile, Profile, Wrap
from forms_pipeline.contract import MEASUREMENT_KEYS, ContractError

# Provisional, chosen 2026-11-10 from a regeneration sweep on a private
# workbench copy (child, adult and large-adult legs all built cleanly). To be
# set from the hand-printed guard's values and the Zane walkthrough
# (docs/SCAN-V3-PLAN.md section 6a).
DEFAULT_WRAP = Wrap(inner_shin=0.35, inner_calf=0.6, outer=0.7)
DEFAULT_PROFILE = CrestSplineV1Profile(kind="crest_spline_v1", wrap=DEFAULT_WRAP)

# Per-slice dimension suffixes of the 25-variable schema. Slice prefixes and
# the passthrough key (leg length) are derived from MEASUREMENT_KEYS so no
# variable name is restated here.
_DIMS = ("ISW", "ISD", "ICW", "ICD", "OW", "OD")


def _split(key: str) -> tuple[str, str]:
    prefix, _, suffix = key.rpartition("_")
    return prefix, suffix


_SLICES: tuple[str, ...] = tuple(
    dict.fromkeys(_split(key)[0] for key in MEASUREMENT_KEYS if _split(key)[1] in _DIMS)
)
_PASSTHROUGH: tuple[str, ...] = tuple(
    key for key in MEASUREMENT_KEYS if _split(key)[1] not in _DIMS
)
_EXPECTED_KEYS = {f"{s}_{d}" for s in _SLICES for d in _DIMS} | set(_PASSTHROUGH)

if len(_PASSTHROUGH) != 1 or _EXPECTED_KEYS != set(MEASUREMENT_KEYS):
    raise ContractError(
        "measurement schema no longer matches the leg length plus slices x "
        f"{_DIMS} shape that cad/profile.py converts"
    )

(LEG_LENGTH_KEY,) = _PASSTHROUGH

_DECIMALS = 2  # outputs rounded to 0.01 mm


class ProfileError(ValueError):
    """Non-retriable: the measurements cannot be converted to model values.

    Raised for a missing key or a non-finite or non-positive input. Messages
    name the key only, never the value: values are minors' body data and this
    message lands in pipeline_jobs.error.
    """


def _positive_input(values_mm: Mapping[str, float], key: str) -> float:
    if key not in values_mm:
        raise ProfileError(f"cannot apply CAD profile: measurement {key} is missing")
    value = values_mm[key]
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ProfileError(
            f"cannot apply CAD profile: measurement {key} must be a finite positive number"
        )
    return float(value)


def _depth(x: float, a: float, b: float) -> float:
    """How far the ellipse (semi-axes a, b) falls back from its crest at offset x; |x| < a."""
    return b * (1 - math.sqrt(1 - (x / a) ** 2))


def _crest_spline_v1(values_mm: Mapping[str, float], wrap: Wrap) -> dict[str, float]:
    out: dict[str, float] = {LEG_LENGTH_KEY: _positive_input(values_mm, LEG_LENGTH_KEY)}
    for s in _SLICES:
        # v1 models the section as a symmetric ellipse from full width and
        # depth only. The leg ISW/ICW/ISD/ICD inputs are ignored: extraction's
        # medial/lateral split is not anatomically oriented yet.
        a = _positive_input(values_mm, f"{s}_OW") / 2
        b = _positive_input(values_mm, f"{s}_OD") / 2
        isw = wrap.inner_shin * a
        icw = wrap.inner_calf * a
        ow = wrap.outer * a
        out[f"{s}_ISW"] = isw
        out[f"{s}_ISD"] = _depth(isw, a, b)
        out[f"{s}_ICW"] = icw
        out[f"{s}_ICD"] = _depth(icw, a, b)
        out[f"{s}_OW"] = ow
        out[f"{s}_OD"] = _depth(ow, a, b)
    return {key: round(out[key], _DECIMALS) for key in MEASUREMENT_KEYS}


def apply_profile(values_mm: Mapping[str, float], profile: Profile) -> dict[str, float]:
    """Convert leg measurements (mm) to the model's variable values (mm) per `profile`."""
    if isinstance(profile, IdentityProfile):
        return dict(values_mm)
    if isinstance(profile, CrestSplineV1Profile):
        return _crest_spline_v1(values_mm, profile.wrap)
    # Unreachable for a validated descriptor; kept so a new kind added to the
    # model without a conversion here fails the job instead of passing through.
    raise ProfileError(f"no conversion implemented for CAD profile kind {profile.kind!r}")
