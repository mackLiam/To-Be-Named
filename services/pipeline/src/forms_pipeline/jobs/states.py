"""Pipeline job state machine, mirroring supabase/migrations/0001_schema.sql.

The `step` check constraint on `public.pipeline_jobs` and the transitions
enforced here must stay in sync; this module is the Python-side source of
truth for "is this transition legal", used by the worker before it ever
calls `advance_pipeline_job`/`complete_pipeline_job` so an illegal jump is
caught in application code, not discovered as a silent bad row in Postgres.
"""

from __future__ import annotations

# Order matches docs/DESIGN.md section 6's state diagram and the `step`
# check constraint in supabase/migrations/0001_schema.sql.
STATES: tuple[str, ...] = (
    "captured",
    "uploaded",
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

# The linear happy path, plus "any step -> failed" (docs/DESIGN.md section 6:
# "(any step) -> failed(step, reason, retriable)").
_LINEAR_STEPS = [s for s in STATES if s != "failed"]

VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    step: frozenset(
        {_LINEAR_STEPS[i + 1]} | {"failed"} if i + 1 < len(_LINEAR_STEPS) else {"failed"}
    )
    for i, step in enumerate(_LINEAR_STEPS)
}
VALID_TRANSITIONS["failed"] = frozenset()  # failed is terminal; no transitions out


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
