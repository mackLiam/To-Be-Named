"""Typed, non-retriable estimator errors (docs/ESTIMATOR-V1.md section 5).

Every error carries a fixed user-facing message with no numbers and an internal
`code`. The same observations or prior fail the same way on every run, so the
wiring (Phase 1b) lists both classes as non-retriable. Nothing here may ever
carry a value, ring or sigma: exception text ends up in pipeline_jobs.error,
which admins read in a browser.
"""

from __future__ import annotations

from typing import ClassVar

ESTIMATOR_CODES: frozenset[str] = frozenset(
    {
        "bad_profile",
        "no_sections",
        "bad_manual_keys",
        "bad_manual_value",
        "bad_observations",
        "bad_noise",
        "too_many_rows",
        "too_many_sources",
        "duplicate_pass_through",
        "singular",
        "non_finite_result",
        "bad_stature",
        "bad_state",
        "bad_fit_check",
        "invalid_leg_model",
    }
)

PRIOR_CODES: frozenset[str] = frozenset(
    {
        "prior_missing",
        "prior_too_large",
        "prior_not_json",
        "prior_malformed",
        "prior_format",
        "prior_version",
        "prior_schema_version",
        "prior_grid",
        "prior_components",
        "prior_non_finite",
        "prior_sigma",
        "prior_correlation",
        "prior_kernel",
        "prior_jitter",
        "prior_covariate",
        "prior_not_positive_definite",
    }
)


class EstimatorError(RuntimeError):
    """Non-retriable: these observations cannot produce a leg estimate."""

    USER_MESSAGE: ClassVar[str] = (
        "We could not build a leg model from this scan. Please scan again or enter "
        "your measurements."
    )
    CODES: ClassVar[frozenset[str]] = ESTIMATOR_CODES

    def __init__(self, code: str) -> None:
        # An unknown code is a programming error; it still must not leak text.
        self.code = code if code in self.CODES else "internal"
        super().__init__(self.USER_MESSAGE)


class PriorError(EstimatorError):
    """Non-retriable: the prior data file is missing or fails validation."""

    USER_MESSAGE: ClassVar[str] = (
        "The leg model is not available right now. Please enter your measurements."
    )
    CODES: ClassVar[frozenset[str]] = PRIOR_CODES
