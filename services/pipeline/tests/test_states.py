from __future__ import annotations

import pytest

from forms_pipeline.jobs.states import (
    STATES,
    VALID_TRANSITIONS,
    InvalidTransitionError,
    guard_transition,
    is_valid_transition,
)


def test_states_order_matches_sql_and_ts() -> None:
    assert STATES == (
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


def test_transition_table_is_the_pinned_contract() -> None:
    # Same table as packages/shared/tests/states.test.ts (plan amendment A3).
    assert VALID_TRANSITIONS == {
        "captured": {"uploaded", "failed"},
        "uploaded": {"reconstructing", "measuring", "failed"},
        "reconstructing": {"measuring", "failed"},
        "measuring": {"measured", "failed"},
        "measured": {"failed"},
        "generating_cad": {"stl_ready", "failed"},
        "stl_ready": {"queued_for_print", "failed"},
        "queued_for_print": {"printing", "failed"},
        "printing": {"shipped", "failed"},
        "shipped": set(),
        "failed": set(),
    }
    assert set(VALID_TRANSITIONS) == set(STATES)


@pytest.mark.parametrize(
    ("current", "nxt"),
    [
        ("uploaded", "reconstructing"),
        ("uploaded", "measuring"),
        ("reconstructing", "measuring"),
        ("measuring", "measured"),
        ("generating_cad", "stl_ready"),
        ("printing", "shipped"),
    ],
)
def test_photo_mesh_and_cad_paths_are_legal(current: str, nxt: str) -> None:
    assert is_valid_transition(current, nxt)
    guard_transition(current, nxt)  # must not raise


def test_any_non_terminal_step_to_failed_is_legal() -> None:
    for step in STATES:
        if step in {"failed", "shipped"}:
            continue
        assert is_valid_transition(step, "failed")


@pytest.mark.parametrize(
    ("current", "nxt"),
    [
        ("captured", "stl_ready"),
        ("reconstructing", "measured"),
        ("uploaded", "measured"),
        # A measure job completes at measured; CAD is a separate job.
        ("measured", "generating_cad"),
        ("measured", "uploaded"),
    ],
)
def test_illegal_transitions_rejected(current: str, nxt: str) -> None:
    assert not is_valid_transition(current, nxt)
    with pytest.raises(InvalidTransitionError):
        guard_transition(current, nxt)


def test_terminal_steps_have_no_way_out() -> None:
    for step in STATES:
        assert not is_valid_transition("failed", step)
        assert not is_valid_transition("shipped", step)


def test_unknown_step_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Unknown current step"):
        is_valid_transition("not_a_real_step", "failed")
    with pytest.raises(ValueError, match="Unknown next step"):
        is_valid_transition("captured", "not_a_real_step")
