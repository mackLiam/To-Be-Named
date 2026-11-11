from __future__ import annotations

import json

import httpx
import pytest

from forms_pipeline.cad.dispatch import CadDispatcher, default_descriptor, resolve_descriptor
from forms_pipeline.cad.model import (
    CadModelDescriptor,
    CadResult,
    CrestSplineV1Profile,
    DescriptorError,
    IdentityProfile,
)
from forms_pipeline.cad.profile import DEFAULT_PROFILE, ProfileError, apply_profile
from forms_pipeline.cad.providers import (
    DRY_RUN_STL,
    DryRunProvider,
    OnshapeProvider,
    ProviderNotFoundError,
    get_provider,
)
from forms_pipeline.config import Settings
from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA_VERSION

_FAKE_SECRET = "test-secret"  # noqa: S105 - test fixture value, not a real secret


def _values() -> dict[str, float]:
    return {key: 100.0 for key in MEASUREMENT_KEYS}


_IDENTITY_PROFILE = {"kind": "identity"}


def _crest_profile(**wrap: object) -> dict[str, object]:
    return {
        "kind": "crest_spline_v1",
        "wrap": {"inner_shin": 0.35, "inner_calf": 0.6, "outer": 0.7, **wrap},
    }


def _good_descriptor_dict() -> dict[str, object]:
    return {
        "provider": "onshape",
        "schema_version": SCHEMA_VERSION,
        "ref": {"document_id": "doc", "workspace_id": "ws", "element_id": "el"},
        "variable_map": None,
        "profile": _crest_profile(),
    }


# ---------------------------------------------------------------------------
# Descriptor parsing / validation
# ---------------------------------------------------------------------------


def test_parse_good_descriptor() -> None:
    desc = CadModelDescriptor.parse(_good_descriptor_dict())
    assert desc.provider == "onshape"
    assert desc.ref["document_id"] == "doc"
    assert desc.variable_map is None


def test_parse_rejects_unknown_top_level_key() -> None:
    data = _good_descriptor_dict()
    data["surprise"] = "value"
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse(data)


def test_parse_rejects_variable_map_key_outside_schema() -> None:
    data = _good_descriptor_dict()
    data["variable_map"] = {"NotAReal_Variable": "x"}
    with pytest.raises(DescriptorError, match="subset of the 25 schema names"):
        CadModelDescriptor.parse(data)


def test_parse_rejects_variable_map_that_collapses_names() -> None:
    data = _good_descriptor_dict()
    # Two distinct schema names mapped onto one model variable -> cannot
    # resolve all 25 to distinct targets (incomplete resolution).
    a, b = MEASUREMENT_KEYS[0], MEASUREMENT_KEYS[1]
    data["variable_map"] = {a: "same", b: "same"}
    with pytest.raises(DescriptorError, match="resolve all 25"):
        CadModelDescriptor.parse(data)


def test_variable_kind_defaults_to_part_studio_features() -> None:
    assert CadModelDescriptor.parse(_good_descriptor_dict()).variable_kind == "part_studio_features"


def test_parse_accepts_variable_studio_kind() -> None:
    data = {**_good_descriptor_dict(), "variable_kind": "variable_studio"}
    assert CadModelDescriptor.parse(data).variable_kind == "variable_studio"


@pytest.mark.parametrize("kind", ["feature_studio", "", None])
def test_parse_rejects_unknown_variable_kind(kind: object) -> None:
    data = {**_good_descriptor_dict(), "variable_kind": kind}
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse(data)


def test_parse_accepts_valid_variable_map() -> None:
    data = _good_descriptor_dict()
    data["variable_map"] = {MEASUREMENT_KEYS[0]: "renamed"}
    desc = CadModelDescriptor.parse(data)
    assert desc.variable_map == {MEASUREMENT_KEYS[0]: "renamed"}


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_get_provider_known_names() -> None:
    assert isinstance(get_provider("dry_run", Settings(_env_file=None)), DryRunProvider)
    assert isinstance(get_provider("onshape", Settings(_env_file=None)), OnshapeProvider)


def test_get_provider_unknown_name_raises() -> None:
    with pytest.raises(ProviderNotFoundError, match="unknown CAD provider"):
        get_provider("nope", Settings(_env_file=None))


# ---------------------------------------------------------------------------
# Dry-run provider
# ---------------------------------------------------------------------------


def test_dry_run_provider_returns_canned_stl() -> None:
    desc = CadModelDescriptor.parse(
        {
            "provider": "dry_run",
            "schema_version": SCHEMA_VERSION,
            "ref": {},
            "variable_map": None,
            "profile": _IDENTITY_PROFILE,
        }
    )
    result = DryRunProvider().generate_stl("job-1", _values(), desc)
    assert result.stl_bytes == DRY_RUN_STL
    assert result.artifacts == {}


# ---------------------------------------------------------------------------
# Onshape provider: descriptor ref and variable_map drive the wire calls
# ---------------------------------------------------------------------------


def _configured_settings() -> Settings:
    # Distinct settings ref so a test can prove the descriptor ref wins.
    return Settings(
        _env_file=None,
        onshape_access_key="test-access",
        onshape_secret_key=_FAKE_SECRET,
        onshape_document_id="settings-doc",
        onshape_workspace_id="settings-ws",
        onshape_element_id="settings-el",
    )


def _onshape_provider_with_capture(
    settings: Settings, captured: dict[str, object]
) -> OnshapeProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.setdefault("paths", []).append(request.url.path)  # type: ignore[union-attr]
        if request.url.path.endswith("/variables"):
            captured["variables_body"] = json.loads(request.content)
            return httpx.Response(200, json={})
        if request.url.path.endswith("/stl"):
            return httpx.Response(200, content=b"solid real\nendsolid real\n")
        raise AssertionError(f"unexpected path {request.url.path}")

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport, base_url=settings.onshape_base_url)
    return OnshapeProvider(settings=settings, http_client=http_client)


def test_onshape_provider_uses_descriptor_ref_not_settings_ref() -> None:
    captured: dict[str, object] = {}
    provider = _onshape_provider_with_capture(_configured_settings(), captured)
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": "desc-doc", "workspace_id": "desc-ws", "element_id": "desc-el"},
            "variable_map": None,
            "variable_kind": "variable_studio",
            "profile": _IDENTITY_PROFILE,
        }
    )

    result = provider.generate_stl("job-1", _values(), desc)

    assert result.stl_bytes == b"solid real\nendsolid real\n"
    assert captured["paths"] == [  # no translation call: export regenerates
        "/api/v6/variables/d/desc-doc/w/desc-ws/e/desc-el/variables",
        "/api/v6/partstudios/d/desc-doc/w/desc-ws/e/desc-el/stl",
    ]
    paths: list[str] = captured["paths"]  # type: ignore[assignment]
    assert paths, "expected network calls in non-dry-run mode"
    for path in paths:
        assert "desc-doc" in path and "desc-ws" in path and "desc-el" in path
        assert "settings-doc" not in path


def test_onshape_provider_applies_variable_map_to_payload_names() -> None:
    captured: dict[str, object] = {}
    provider = _onshape_provider_with_capture(_configured_settings(), captured)
    renamed_from = MEASUREMENT_KEYS[0]
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": "d", "workspace_id": "w", "element_id": "e"},
            "variable_map": {renamed_from: "Model_Var_0"},
            "variable_kind": "variable_studio",
            "profile": _IDENTITY_PROFILE,
        }
    )

    provider.generate_stl("job-1", _values(), desc)

    sent_names = {item["name"] for item in captured["variables_body"]}  # type: ignore[union-attr]
    assert "Model_Var_0" in sent_names
    assert renamed_from not in sent_names
    # All other 24 schema names pass through unchanged.
    assert sent_names == ({"Model_Var_0"} | set(MEASUREMENT_KEYS[1:]))


def test_onshape_provider_rejects_ref_missing_ids() -> None:
    provider = OnshapeProvider(settings=_configured_settings())
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": "d"},  # missing workspace_id, element_id
            "variable_map": None,
            "profile": _IDENTITY_PROFILE,
        }
    )
    with pytest.raises(DescriptorError, match="missing required id"):
        provider.generate_stl("job-1", _values(), desc)


def test_onshape_provider_dry_run_without_credentials() -> None:
    # No credentials -> OnshapeClient.dry_run -> canned STL, no network calls.
    provider = OnshapeProvider(settings=Settings(_env_file=None))
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": "d", "workspace_id": "w", "element_id": "e"},
            "variable_map": None,
            "profile": _IDENTITY_PROFILE,
        }
    )
    result = provider.generate_stl("job-1", _values(), desc)
    assert result.stl_bytes == DRY_RUN_STL
    assert result.artifacts["dry_run"] is True


# ---------------------------------------------------------------------------
# Dispatcher: resolution + fallback default
# ---------------------------------------------------------------------------


def test_default_descriptor_is_dry_run_without_credentials() -> None:
    desc = default_descriptor(Settings(_env_file=None))
    assert desc.provider == "dry_run"
    assert desc.schema_version == SCHEMA_VERSION


def test_default_descriptor_is_onshape_with_credentials() -> None:
    desc = default_descriptor(_configured_settings())
    assert desc.provider == "onshape"
    assert desc.ref["document_id"] == "settings-doc"


def test_resolve_descriptor_falls_back_when_none() -> None:
    desc = resolve_descriptor(None, Settings(_env_file=None))
    assert desc.provider == "dry_run"


def test_resolve_descriptor_parses_stored_dict() -> None:
    desc = resolve_descriptor(_good_descriptor_dict(), Settings(_env_file=None))
    assert desc.provider == "onshape"


def test_dispatcher_run_returns_stl_and_logs_latency(caplog: pytest.LogCaptureFixture) -> None:
    dispatcher = CadDispatcher(settings=Settings(_env_file=None))
    with caplog.at_level("INFO"):
        stl = dispatcher.generate("job-1", _values(), None).stl_bytes  # None -> dry-run default
    assert stl == DRY_RUN_STL
    assert any(
        "cad generation complete" in rec.message and "job-1" in rec.message
        for rec in caplog.records
    )


def test_dispatcher_generate_returns_cad_result() -> None:
    result = CadDispatcher(settings=Settings(_env_file=None)).generate("job-1", _values(), None)
    assert result.stl_bytes == DRY_RUN_STL


# ---------------------------------------------------------------------------
# Descriptor profile validation (mirrored in packages/shared)
# ---------------------------------------------------------------------------


def test_parse_accepts_identity_profile() -> None:
    desc = CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": _IDENTITY_PROFILE})
    assert isinstance(desc.profile, IdentityProfile)


def test_parse_accepts_crest_spline_v1_profile() -> None:
    desc = CadModelDescriptor.parse(_good_descriptor_dict())
    assert isinstance(desc.profile, CrestSplineV1Profile)
    assert desc.profile.wrap.inner_shin == 0.35
    assert desc.profile.wrap.inner_calf == 0.6
    assert desc.profile.wrap.outer == 0.7


def test_parse_rejects_missing_profile() -> None:
    data = _good_descriptor_dict()
    del data["profile"]
    with pytest.raises(DescriptorError, match="profile"):
        CadModelDescriptor.parse(data)


@pytest.mark.parametrize("profile", [None, "identity", [], 1])
def test_parse_rejects_non_object_profile(profile: object) -> None:
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


@pytest.mark.parametrize("kind", ["crest_spline_v2", "", None, "IDENTITY"])
def test_parse_rejects_unknown_profile_kind(kind: object) -> None:
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": {"kind": kind}})


def test_parse_rejects_profile_without_kind() -> None:
    profile = _crest_profile()
    del profile["kind"]
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


def test_parse_rejects_identity_with_wrap() -> None:
    profile = {"kind": "identity", "wrap": _crest_profile()["wrap"]}
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


@pytest.mark.parametrize("kind", ["identity", "crest_spline_v1"])
def test_parse_rejects_unknown_key_in_profile(kind: str) -> None:
    profile = {**(_IDENTITY_PROFILE if kind == "identity" else _crest_profile()), "extra": 1}
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


def test_parse_rejects_crest_spline_without_wrap() -> None:
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse(
            {**_good_descriptor_dict(), "profile": {"kind": "crest_spline_v1"}}
        )


@pytest.mark.parametrize("wrap", [None, [], 0.5, "x"])
def test_parse_rejects_non_object_wrap(wrap: object) -> None:
    profile = {"kind": "crest_spline_v1", "wrap": wrap}
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


@pytest.mark.parametrize("missing", ["inner_shin", "inner_calf", "outer"])
def test_parse_rejects_wrap_missing_key(missing: str) -> None:
    profile = _crest_profile()
    del profile["wrap"][missing]  # type: ignore[attr-defined]
    with pytest.raises(DescriptorError, match=missing):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": profile})


def test_parse_rejects_wrap_unknown_key() -> None:
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse(
            {**_good_descriptor_dict(), "profile": _crest_profile(depth_scale=0.5)}
        )


@pytest.mark.parametrize("key", ["inner_shin", "inner_calf", "outer"])
@pytest.mark.parametrize("bad", [True, False, "0.5", None, float("nan"), float("inf")])
def test_parse_rejects_non_finite_or_non_number_wrap(key: str, bad: object) -> None:
    with pytest.raises(DescriptorError):
        CadModelDescriptor.parse(
            {**_good_descriptor_dict(), "profile": _crest_profile(**{key: bad})}
        )


@pytest.mark.parametrize(
    "wrap",
    [
        {"inner_shin": 0.6, "inner_calf": 0.6},  # inner_shin == inner_calf
        {"inner_shin": 0.7, "inner_calf": 0.6},  # inner_shin > inner_calf
        {"inner_shin": 0.0},  # inner_shin at 0
        {"inner_shin": -0.1},
        {"inner_calf": 1.0},  # inner_calf at 1
        {"inner_calf": 1.2},
        {"outer": 0.0},
        {"outer": 1.0},
        {"outer": -0.3},
    ],
)
def test_parse_rejects_wrap_ordering_violations(wrap: dict[str, float]) -> None:
    with pytest.raises(DescriptorError, match="wrap must satisfy"):
        CadModelDescriptor.parse({**_good_descriptor_dict(), "profile": _crest_profile(**wrap)})


def test_parse_accepts_outer_independent_of_inner_ordering() -> None:
    # outer only needs 0 < outer < 1; it may sit below inner_shin.
    desc = CadModelDescriptor.parse(
        {**_good_descriptor_dict(), "profile": _crest_profile(outer=0.1)}
    )
    assert desc.profile.wrap.outer == 0.1  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Dispatcher applies the profile before the provider
# ---------------------------------------------------------------------------


class _RecordingProvider:
    name = "recording"

    def __init__(self, artifacts: dict[str, object] | None = None) -> None:
        self.calls: list[dict[str, float]] = []
        self._artifacts = artifacts or {}

    def generate_stl(
        self, job_id: str, values_mm: dict[str, float], model: CadModelDescriptor
    ) -> CadResult:
        self.calls.append(dict(values_mm))
        return CadResult(b"solid x\nendsolid x\n", dict(self._artifacts))


def _dispatcher_with(provider: _RecordingProvider) -> CadDispatcher:
    return CadDispatcher(settings=Settings(_env_file=None), provider_factory=lambda _name: provider)


def test_default_descriptor_carries_default_profile() -> None:
    for settings in (Settings(_env_file=None), _configured_settings()):
        assert default_descriptor(settings).profile == DEFAULT_PROFILE


def test_dispatcher_sends_model_values_not_leg_values() -> None:
    provider = _RecordingProvider(artifacts={"job_document_id": "jd"})
    leg = _values()

    result = _dispatcher_with(provider).generate("job-1", leg, _good_descriptor_dict())

    [sent] = provider.calls
    expected = apply_profile(leg, DEFAULT_PROFILE)
    assert sent == expected
    assert sent != leg
    # Leg OW of 100mm -> model OW = 0.7 * 50 = 35mm (still mm: no unit conversion here).
    assert sent["S1_OW"] == 35.0
    assert result.artifacts == {
        "job_document_id": "jd",
        "profile_kind": "crest_spline_v1",
        "model_values_mm": expected,
    }


def test_dispatcher_identity_profile_passes_leg_values() -> None:
    provider = _RecordingProvider()
    leg = _values()
    descriptor = {**_good_descriptor_dict(), "profile": _IDENTITY_PROFILE}

    result = _dispatcher_with(provider).generate("job-1", leg, descriptor)

    assert provider.calls == [leg]
    assert result.artifacts["profile_kind"] == "identity"
    assert result.artifacts["model_values_mm"] == leg


def test_dispatcher_default_descriptor_applies_default_profile() -> None:
    provider = _RecordingProvider()
    _dispatcher_with(provider).generate("job-1", _values(), None)
    assert provider.calls == [apply_profile(_values(), DEFAULT_PROFILE)]


def test_dispatcher_profile_error_raised_before_provider_call() -> None:
    provider = _RecordingProvider()
    leg = _values()
    leg["S3_OD"] = 0.0
    with pytest.raises(ProfileError, match="S3_OD"):
        _dispatcher_with(provider).generate("job-1", leg, _good_descriptor_dict())
    assert provider.calls == []
