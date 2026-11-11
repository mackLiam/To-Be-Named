"""shape/observe.py: mesh sections, noise structure, scale-free captures, typed values."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
import trimesh
from test_shape_model import loft_mesh, synthetic_state

from forms_pipeline.extraction.measure import MeasurementError, extract_measurements
from forms_pipeline.shape import observe
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.fuse import fuse
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    GRID_T,
    IDX_L,
    LEG_LENGTH_KEY,
    SLICE_K,
    K,
    depths_mm,
    idx_d,
    idx_w,
    project,
    state_index,
    widths_mm,
)
from forms_pipeline.shape.observe import (
    MANUAL_KEYS,
    NOISE,
    OBSERVABLE_K,
    PASS_THROUGH_EFFECTIVE_MM,
    SectionProfile,
    depth_sigma_mm,
    observations_from_manual,
    observations_from_profile,
    section_profile_from_mesh,
)
from forms_pipeline.shape.prior import load_prior


def profile_from_state(
    x: np.ndarray,
    source: str = "mesh",
    ks: tuple[int, ...] = OBSERVABLE_K,
    span: float | None = None,
) -> SectionProfile:
    w, d = widths_mm(x), depths_mm(x)
    return SectionProfile(
        source=source,  # type: ignore[arg-type]
        leg_length_mm=float(np.exp(x[IDX_L])),
        t=tuple(float(GRID_T[k]) for k in ks),
        width_mm=tuple(float(w[k]) for k in ks),
        depth_mm=tuple(float(d[k]) for k in ks),
        azimuth_span_deg=span,
    )


def _no_digits(exc: BaseException) -> bool:
    return not any(ch.isdigit() for ch in str(exc))


def test_mesh_parity_with_extraction_is_exact() -> None:
    mesh = loft_mesh(synthetic_state(), t_step=0.0125)
    profile = section_profile_from_mesh(mesh, "mesh")
    extracted = extract_measurements(mesh).values
    assert profile.source == "mesh" and profile.azimuth_span_deg is None
    assert profile.leg_length_mm == extracted[LEG_LENGTH_KEY]
    assert profile.t == tuple(float(GRID_T[k]) for k in OBSERVABLE_K)
    obs = observations_from_profile(profile)
    for s, k in SLICE_K.items():
        j = profile.t.index(float(GRID_T[k]))
        assert profile.width_mm[j] == extracted[f"{s}_OW"]
        assert profile.depth_mm[j] == extracted[f"{s}_OD"]
        row_w = int(np.flatnonzero(obs.index == idx_w(k))[0])
        row_d = int(np.flatnonzero(obs.index == idx_d(k))[0])
        assert obs.y[row_w] == math.log(extracted[f"{s}_OW"])
        assert obs.y[row_d] == math.log(extracted[f"{s}_OD"])
    assert obs.y[0] == math.log(extracted[LEG_LENGTH_KEY])


def _two_piece_tube() -> trimesh.Trimesh:
    """A leg whose middle (z between 35% and 65% of its length) is missing."""
    x = synthetic_state()
    full = loft_mesh(x, t_step=0.0125)
    length = float(np.exp(x[IDX_L]))
    z = full.vertices[:, 2]
    keep = (z <= 0.35 * length + 1e-6) | (z >= 0.65 * length - 1e-6)
    face_keep = keep[full.faces].all(axis=1)
    return trimesh.Trimesh(vertices=full.vertices, faces=full.faces[face_keep], process=False)


def test_missing_slices_are_dropped() -> None:
    profile = section_profile_from_mesh(_two_piece_tube(), "silhouette", azimuth_span_deg=170.0)
    ks = [int(round(t * 20)) for t in profile.t]
    assert ks, "the remaining sections must survive"
    assert all(k <= 7 or k >= 13 for k in ks)
    assert 8 not in ks and 12 not in ks and 10 not in ks
    assert 1 in ks and 19 in ks
    obs = observations_from_profile(profile)
    assert obs.rows == 1 + 2 * len(ks)


def test_no_sections_at_all_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def always_fail(mesh_rot: Any, z: float) -> dict[str, float]:
        raise MeasurementError("no section")

    monkeypatch.setattr(observe, "slice_dims", always_fail)
    with pytest.raises(EstimatorError) as info:
        section_profile_from_mesh(loft_mesh(synthetic_state()), "mesh")
    assert info.value.code == "no_sections" and _no_digits(info.value)


def test_noise_is_positive_definite_and_scale_term_includes_length() -> None:
    x = synthetic_state()
    for source in ("mesh", "silhouette", "scale_free"):
        obs = observations_from_profile(profile_from_state(x, source, span=120.0))
        cov = obs.noise_cov
        np.linalg.cholesky(cov)
        assert np.array_equal(cov, cov.T)
        scale2 = NOISE[source].scale_log_sigma ** 2
        length = float(np.exp(x[IDX_L]))
        assert cov[0, 0] == pytest.approx((NOISE[source].length_mm / length) ** 2 + scale2)
        # L shares only the per-capture scale nuisance with every other row.
        np.testing.assert_allclose(cov[0, 1:], scale2, rtol=1e-12)
        assert obs.report_cov is obs.noise_cov
        assert not obs.pass_through


def test_noise_block_structure_matches_the_contract() -> None:
    x = synthetic_state()
    ks = (2, 4, 9)
    obs = observations_from_profile(profile_from_state(x, "mesh", ks=ks))
    w = widths_mm(x)[list(ks)]
    s = 1.5 / w
    t = GRID_T[list(ks)]
    kern = np.exp(-((t[:, None] - t[None, :]) ** 2) / (2 * 0.25**2))
    expected = np.diag(s) @ (0.5 * np.eye(3) + 0.5 * kern) @ np.diag(s) + 0.02**2
    np.testing.assert_allclose(obs.noise_cov[1:4, 1:4], expected, rtol=1e-12)
    # Width and depth blocks are coupled only through the scale nuisance.
    np.testing.assert_allclose(obs.noise_cov[1:4, 4:7], 0.02**2, rtol=1e-12)
    assert list(obs.index) == [0, idx_w(2), idx_w(4), idx_w(9), idx_d(2), idx_d(4), idx_d(9)]


@pytest.mark.parametrize(
    ("source", "span", "expected"),
    [
        ("mesh", None, 2.0),
        ("mesh", 10.0, 2.0),
        ("silhouette", None, 6.0),
        ("silhouette", 180.0, 3.0),
        ("silhouette", 150.0, 3.0),
        ("silhouette", 135.0, 4.5),
        ("silhouette", 120.0, 6.0),
        ("silhouette", 90.0, 6.0),
        ("silhouette", 0.0, 6.0),
        ("scale_free", None, 6.0),
        ("scale_free", 141.0, 3.9),
    ],
)
def test_depth_sigma_depends_on_span(source: str, span: float | None, expected: float) -> None:
    assert depth_sigma_mm(source, span) == pytest.approx(expected)  # type: ignore[arg-type]


def test_scale_free_gives_shape_without_size() -> None:
    prior = load_prior()
    truth = prior.mean.copy()
    truth += np.log(1.3)  # every length 30% larger than the prior mean
    truth[1 + K :] += 0.05 * np.sin(np.pi * GRID_T)  # and a smooth shape change in depth
    post_free = fuse(prior, [observations_from_profile(profile_from_state(truth, "scale_free"))])
    post_mesh = fuse(prior, [observations_from_profile(profile_from_state(truth, "mesh"))])

    def shape(v: np.ndarray) -> np.ndarray:
        return v[1:] - v[IDX_L]  # log ratios to L: scale-free

    observed = [IDX_L, *(idx_w(k) for k in OBSERVABLE_K), *(idx_d(k) for k in OBSERVABLE_K)]
    np.testing.assert_allclose(
        shape(post_free.mean)[np.array(observed[1:]) - 1],
        shape(truth)[np.array(observed[1:]) - 1],
        atol=0.01,
    )
    sd_prior = math.sqrt(prior.cov[0, 0])
    assert math.sqrt(post_free.cov[0, 0]) > 0.85 * sd_prior
    assert abs(post_free.mean[0] - truth[0]) > 0.15  # size stays near the prior
    assert abs(post_mesh.mean[0] - truth[0]) < 0.01  # the same capture with scale sees it
    assert math.sqrt(post_mesh.cov[0, 0]) < 0.1 * sd_prior


def test_manual_nine_keys_give_nine_rows() -> None:
    values = {k: v for k, v in project(synthetic_state()).items() if k in MANUAL_KEYS}
    assert len(values) == 9
    for adjusted, source in ((False, "manual"), (True, "adjusted")):
        obs = observations_from_manual(values, adjusted=adjusted)
        assert obs.source == source
        assert obs.rows == 9
        assert list(obs.index) == [state_index(k) for k in FIT_CRITICAL_KEYS]
        assert dict(obs.pass_through) == values
        v = np.array([values[k] for k in FIT_CRITICAL_KEYS])
        np.testing.assert_allclose(obs.y, np.log(v))
        np.testing.assert_allclose(np.diag(obs.noise_cov), (PASS_THROUGH_EFFECTIVE_MM / v) ** 2)
        tape = np.array([5.0] + [3.0] * 8)
        np.testing.assert_allclose(np.diag(obs.report_cov), (tape / v) ** 2)


def test_manual_subset_is_allowed() -> None:
    obs = observations_from_manual({"S2_OD": 88.0}, adjusted=False)
    assert obs.rows == 1 and list(obs.index) == [state_index("S2_OD")]


@pytest.mark.parametrize(
    "values",
    [
        {},
        {"S1_ISW": 40.0},
        {"S1_OW": 80.0, "S1_ISW": 40.0},
        {"Leg_length": 380.0},
        {"S5_OW": 80.0},
    ],
)
def test_manual_wrong_keys_raise(values: dict[str, float]) -> None:
    with pytest.raises(EstimatorError) as info:
        observations_from_manual(values, adjusted=False)
    assert info.value.code == "bad_manual_keys" and _no_digits(info.value)


@pytest.mark.parametrize(
    "value", [float("nan"), float("inf"), -float("inf"), True, "80", None, 8.0, 0.0, -80.0, 500.0]
)
def test_manual_bad_values_raise(value: Any) -> None:
    with pytest.raises(EstimatorError) as info:
        observations_from_manual({"S1_OW": value}, adjusted=True)
    assert info.value.code == "bad_manual_value" and _no_digits(info.value)


def _profile(**changes: Any) -> SectionProfile:
    base = profile_from_state(synthetic_state(), "silhouette", ks=(4, 8), span=120.0)
    fields = {f: getattr(base, f) for f in base.__dataclass_fields__}
    fields.update(changes)
    return SectionProfile(**fields)


@pytest.mark.parametrize(
    "changes",
    [
        {"t": (0.2, 0.41)},
        {"t": (0.0, 0.4)},
        {"t": (0.2, 1.0)},
        {"t": (0.2, 0.2)},
        {"t": (0.2,)},
        {"width_mm": (80.0, -1.0)},
        {"width_mm": (80.0, float("nan"))},
        {"depth_mm": (80.0, 0.0)},
        {"depth_mm": (80.0, True)},
        {"leg_length_mm": float("inf")},
        {"leg_length_mm": 0.0},
        {"azimuth_span_deg": -5.0},
        {"azimuth_span_deg": float("nan")},
        {"azimuth_span_deg": 400.0},
        {"source": "manual"},
        {"source": "lidar"},
    ],
)
def test_bad_profiles_raise(changes: dict[str, Any]) -> None:
    with pytest.raises(EstimatorError) as info:
        observations_from_profile(_profile(**changes))
    assert info.value.code == "bad_profile" and _no_digits(info.value)


def test_section_profile_rejects_unknown_source() -> None:
    with pytest.raises(EstimatorError):
        section_profile_from_mesh(loft_mesh(synthetic_state()), "manual")  # type: ignore[arg-type]


def test_observation_arrays_are_read_only() -> None:
    obs = observations_from_profile(profile_from_state(synthetic_state()))
    with pytest.raises(ValueError):
        obs.y[0] = 0.0
