from __future__ import annotations

from itertools import pairwise

import pytest

from zells_pipeline.jobs.states import (
    STATES,
    InvalidTransitionError,
    guard_transition,
    is_valid_transition,
)

HAPPY_PATH = [
    "captured",
    "uploaded",
    "measuring",
    "measured",
    "generating_cad",
    "stl_ready",
    "queued_for_print",
    "printing",
    "shipped",
]


def test_happy_path_transitions_are_legal() -> None:
    for current, nxt in pairwise(HAPPY_PATH):
        assert is_valid_transition(current, nxt)
        guard_transition(current, nxt)  # must not raise


def test_any_step_to_failed_is_legal() -> None:
    for step in STATES:
        if step == "failed":
            continue
        assert is_valid_transition(step, "failed")


def test_illegal_jump_rejected() -> None:
    assert not is_valid_transition("captured", "stl_ready")
    with pytest.raises(InvalidTransitionError):
        guard_transition("captured", "stl_ready")


def test_illegal_backward_transition_rejected() -> None:
    assert not is_valid_transition("measured", "uploaded")


def test_failed_is_terminal() -> None:
    for step in STATES:
        assert not is_valid_transition("failed", step)


def test_unknown_step_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Unknown current step"):
        is_valid_transition("not_a_real_step", "failed")
    with pytest.raises(ValueError, match="Unknown next step"):
        is_valid_transition("captured", "not_a_real_step")
