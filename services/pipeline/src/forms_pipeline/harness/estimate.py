"""Report-only leg estimator stage of the harness (docs/ESTIMATOR-V1.md, SCAN-V3-PLAN.md 5.7).

The measured silhouette mesh becomes a "scale_free" SectionProfile, fused with
the provisional prior (no stature) and gated with the provisional tolerances.
Plain video has no scale, so the report carries ratios, relative sigmas (sigma
over value) and categorical outputs; the only absolute mm kept are under keys
starting "nominal_" (the harness's nominal leg length, never a real size). The
stage never raises and never changes the row's pass or fail.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

import trimesh

from forms_pipeline.harness.metrics import ratios, shape_metrics
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.fuse import Posterior, estimate_values, fuse, value_sigmas_mm
from forms_pipeline.shape.gate import DEFAULT_TOLERANCES, GateResult, action_outcomes, evaluate
from forms_pipeline.shape.model import ESTIMATOR_VERSION, FIT_CRITICAL_KEYS, LEG_LENGTH_KEY
from forms_pipeline.shape.observe import (
    OBSERVABLE_K,
    observations_from_manual,
    observations_from_profile,
    section_profile_from_mesh,
)
from forms_pipeline.shape.prior import load_prior

PRIOR_VERSION = "0.1.1"
SOURCE = "scale_free"
HEADING = "Estimator (provisional prior, report only)"
OK = "ok"
FAILED = "failed"


def report_ratios(values: Mapping[str, float]) -> dict[str, float]:
    """OD/OW per slice, OW/OW_S3 per slice and Leg_Length/OW_S3 of 25 values (any scale)."""
    return {k: v for k, v in ratios(shape_metrics(values)).items() if "OD/OD_" not in k}


def relative_sigmas(posterior: Posterior) -> dict[str, float]:
    """sigma / value per fit-critical key: scale-free, unlike sigma in mm."""
    values, sigmas = estimate_values(posterior), value_sigmas_mm(posterior)
    return {key: sigmas[key] / values[key] for key in FIT_CRITICAL_KEYS}


def _gate(result: GateResult) -> dict[str, Any]:
    return {
        "verdict": result.verdict,
        "worst_key": result.worst_key,
        "r": result.worst_ratio if math.isfinite(result.worst_ratio) else None,
        "best_action": None if result.action is None else result.action.to_json(),
    }


def estimator_report(
    mesh_mm: trimesh.Trimesh, azimuth_span_deg: float | None, raw_values: Mapping[str, float]
) -> dict[str, Any]:
    """The estimator section of a successful row. Raises EstimatorError (and PriorError)."""
    profile = section_profile_from_mesh(mesh_mm, SOURCE, azimuth_span_deg)
    observations = observations_from_profile(profile)
    prior = load_prior(PRIOR_VERSION)
    posterior = fuse(prior, [observations], stature_mm=None)
    gate = evaluate(posterior, DEFAULT_TOLERANCES)

    posterior_values = estimate_values(posterior)
    raw, post = report_ratios(raw_values), report_ratios(posterior_values)

    # Covariance ignores y, so a tape at the posterior mean shows the tightening alone.
    tape_mm = posterior_values[LEG_LENGTH_KEY]
    tape = observations_from_manual({LEG_LENGTH_KEY: tape_mm}, adjusted=False)
    what_if = fuse(prior, [observations, tape], stature_mm=None)

    return {
        "status": OK,
        "reason": None,
        "provisional": True,
        "prior_provisional": prior.provisional,
        "prior_version": prior.prior_version,
        "estimator_version": ESTIMATOR_VERSION,
        "source": SOURCE,
        "stature": None,
        "azimuth_span_deg": azimuth_span_deg,
        "heights_observed": len(profile.t),
        "heights_observable": len(OBSERVABLE_K),
        **_gate(gate),
        "r_after_action": {
            (a.key if a.kind == "tape" else a.kind): (r if math.isfinite(r) else None)
            for a, r, _var, _order in action_outcomes(posterior, DEFAULT_TOLERANCES)
        },
        "raw_ratios": raw,
        "posterior_ratios": post,
        "ratio_change_from_raw": {k: post[k] - raw[k] for k in post},
        "relative_sigma": relative_sigmas(posterior),
        "what_if_tape_Leg_Length": {
            "hypothetical": True,
            "nominal_tape_Leg_Length_mm": tape_mm,
            **_gate(evaluate(what_if, DEFAULT_TOLERANCES)),
            "relative_sigma": relative_sigmas(what_if),
        },
    }


def estimator_stage(
    mesh_mm: trimesh.Trimesh, azimuth_span_deg: float | None, raw_values: Mapping[str, float]
) -> dict[str, Any]:
    """estimator_report, or a failed section carrying the reason; never raises.

    An unexpected error records its type only: its text could carry a body value.
    """
    try:
        return estimator_report(mesh_mm, azimuth_span_deg, raw_values)
    except EstimatorError as exc:
        return {"status": FAILED, "reason": str(exc), "code": exc.code, "provisional": True}
    except Exception as exc:  # noqa: BLE001 - report only, must never fail the row
        return {
            "status": FAILED,
            "reason": f"Unexpected {type(exc).__name__}.",
            "code": "unexpected",
            "provisional": True,
        }
