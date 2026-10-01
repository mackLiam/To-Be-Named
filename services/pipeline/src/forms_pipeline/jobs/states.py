"""Pipeline job state machine, mirroring the pipeline_jobs step CHECK
(supabase/migrations/0008_photo_capture.sql) and packages/shared/src/states.ts.

The `step` check constraint on `public.pipeline_jobs` and the transitions
enforced here must stay in sync; this module is the Python-side source of
truth for "is this transition legal", used by the worker before it ever
calls `advance_pipeline_job`/`complete_pipeline_job` so an illegal jump is
caught in application code, not discovered as a silent bad row in Postgres.
"""

from __future__ import annotations

# Order matches docs/DESIGN.md section 6, the `step` CHECK constraint (0008)
# and PIPELINE_STEPS in packages/shared/src/states.ts.
STATES: tuple[str, ...] = (
    "captured",
    "uploaded",
    "reconstructing",
    "measuring",
    "measured",
    "generating_cad",
    "stl_ready",
    "queued_for_print",
    "printing",
    "shipped",
    "failed",
)

TERMINAL_STATES: frozenset[str] = frozenset({"shipped", "failed"})

# Explicit table, identical to VALID_TRANSITIONS in packages/shared/src/states.ts.
# A measure job ends at "measured" (completed there); a CAD job is a separate
# job starting at "generating_cad" (docs/DESIGN.md section 6).
VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    "captured": frozenset({"uploaded", "failed"}),
    "uploaded": frozenset({"reconstructing", "measuring", "failed"}),
    "reconstructing": frozenset({"measuring", "failed"}),
    "measuring": frozenset({"measured", "failed"}),
    "measured": frozenset({"failed"}),
    "generating_cad": frozenset({"stl_ready", "failed"}),
    "stl_ready": frozenset({"queued_for_print", "failed"}),
    "queued_for_print": frozenset({"printing", "failed"}),
    "printing": frozenset({"shipped", "failed"}),
    "shipped": frozenset(),
    "failed": frozenset(),
}


class InvalidTransitionError(ValueError):
    """Raised when a state transition is not permitted by VALID_TRANSITIONS."""


def is_valid_transition(current: str, next_step: str) -> bool:
    if current not in STATES:
        raise ValueError(f"Unknown current step: {current!r}")
    if next_step not in STATES:
        raise ValueError(f"Unknown next step: {next_step!r}")
    return next_step in VALID_TRANSITIONS[current]


def guard_transition(current: str, next_step: str) -> None:
    """Raise InvalidTransitionError unless `current -> next_step` is legal."""
    if not is_valid_transition(current, next_step):
        raise InvalidTransitionError(f"Illegal pipeline transition: {current!r} -> {next_step!r}")
