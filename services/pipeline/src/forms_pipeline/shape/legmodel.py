"""Posterior mean to the forms.leg-model v1 document (docs/ESTIMATOR-V1.md 1, rule 11).

v1 producer: ring k is the ellipse (OW(t_k)/2 on x, OD(t_k)/2 on y) centred on
the axis, point i at angle 2*pi*i/48, crest at [0, OD/2]. Coordinates and
leg_length_mm rounded to 0.1 mm, t to 2 decimals. No sigma, provenance or raw
scan data ever goes in.
"""

from __future__ import annotations

import math
from typing import Any, Literal

import numpy as np

from forms_pipeline.shape.contract import (
    FIT_CHECKS,
    LEG_MODEL_FORMAT,
    LEG_MODEL_FRAME,
    LEG_MODEL_RING_COUNT,
    LEG_MODEL_RING_POINTS,
    LEG_MODEL_VERSION,
    LegModelError,
    parse_leg_model,
)
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.gate import FitAction
from forms_pipeline.shape.model import (
    ESTIMATOR_VERSION,
    GRID_T,
    N_STATE,
    K,
    contour,
    depths_mm,
    widths_mm,
)

_MM_DECIMALS = 1
_T_DECIMALS = 2


def _mm(v: float) -> float:
    # + 0.0 folds -0.0 into 0.0 so the document never carries a signed zero.
    return round(float(v), _MM_DECIMALS) + 0.0


def leg_model(
    x: np.ndarray,
    *,
    leg: Literal["L", "R"],
    prior_version: str,
    fit_check: str,
    fit_action: FitAction | None,
) -> dict[str, Any]:
    """The leg-model document for state x (the posterior mean)."""
    state = np.asarray(x, dtype=np.float64)
    if state.shape != (N_STATE,) or not np.all(np.isfinite(state)):
        raise EstimatorError("bad_state")
    if leg not in ("L", "R"):
        raise EstimatorError("bad_state")
    if fit_check not in FIT_CHECKS or (fit_action is None) != (fit_check == "none"):
        raise EstimatorError("bad_fit_check")

    if K != LEG_MODEL_RING_COUNT:  # pragma: no cover - import-time contract drift
        raise EstimatorError("bad_state")
    w, d = widths_mm(state), depths_mm(state)
    rings = []
    for k in range(K):
        pts = contour(float(w[k]), float(d[k]), LEG_MODEL_RING_POINTS)
        rings.append(
            {
                "t": round(float(GRID_T[k]), _T_DECIMALS),
                "center": [0.0, 0.0],
                "crest": [0.0, _mm(0.5 * d[k])],
                "points": [[_mm(px), _mm(py)] for px, py in pts],
            }
        )
    doc = {
        "format": LEG_MODEL_FORMAT,
        "version": LEG_MODEL_VERSION,
        "leg": leg,
        "units": "mm",
        "frame": LEG_MODEL_FRAME,
        "estimator_version": ESTIMATOR_VERSION,
        "prior_version": prior_version,
        "leg_length_mm": _mm(math.exp(float(state[0]))),
        "rings": rings,
        "fit_check": fit_check,
        "fit_action": None if fit_action is None else fit_action.to_json(),
    }
    # Never emit a document the pinned validator would reject (for example a leg
    # outside the schema range or a ring beyond the coordinate bound).
    try:
        parse_leg_model(doc)
    except LegModelError:
        raise EstimatorError("invalid_leg_model") from None
    return doc
