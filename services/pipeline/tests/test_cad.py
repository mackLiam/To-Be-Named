from __future__ import annotations

import json

import httpx
import pytest

from zells_pipeline.cad.dispatch import CadDispatcher, default_descriptor, resolve_descriptor
from zells_pipeline.cad.model import CadModelDescriptor, DescriptorError
from zells_pipeline.cad.providers import (
    DRY_RUN_STL,
    DryRunProvider,
    OnshapeProvider,
    ProviderNotFoundError,
    get_provider,
)
from zells_pipeline.config import Settings
from zells_pipeline.contract import MEASUREMENT_KEYS, SCHEMA_VERSION

_FAKE_SECRET = "test-secret"  # noqa: S105 - test fixture value, not a real secret


def _values() -> dict[str, float]:
    return {key: 100.0 for key in MEASUREMENT_KEYS}


def _good_descriptor_dict() -> dict[str, object]:
    return {
        "provider": "onshape",
        "schema_version": SCHEMA_VERSION,
        "ref": {"document_id": "doc", "workspace_id": "ws", "element_id": "el"},
        "variable_map": None,
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


def test_parse_accepts_valid_variable_map() -> None:
    data = _good_descriptor_dict()
    data["variable_map"] = {MEASUREMENT_KEYS[0]: "renamed"}
    desc = CadModelDescriptor.parse(data)
    assert desc.variable_map == {MEASUREMENT_KEYS[0]: "renamed"}


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_get_provider_known_names() -> None:
    assert isinstance(get_provider("dry_run", Settings()), DryRunProvider)
    assert isinstance(get_provider("onshape", Settings()), OnshapeProvider)


def test_get_provider_unknown_name_raises() -> None:
    with pytest.raises(ProviderNotFoundError, match="unknown CAD provider"):
        get_provider("nope", Settings())


# ---------------------------------------------------------------------------
# Dry-run provider
# ---------------------------------------------------------------------------


def test_dry_run_provider_returns_canned_stl() -> None:
    desc = CadModelDescriptor.parse(
        {"provider": "dry_run", "schema_version": SCHEMA_VERSION, "ref": {}, "variable_map": None}
    )
    stl = DryRunProvider().generate_stl("job-1", _values(), desc)
    assert stl == DRY_RUN_STL


# ---------------------------------------------------------------------------
# Onshape provider: descriptor ref and variable_map drive the wire calls
# ---------------------------------------------------------------------------


def _configured_settings() -> Settings:
    # Distinct settings ref so a test can prove the descriptor ref wins.
    return Settings(
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
        if request.url.path.endswith("/translations"):
            return httpx.Response(200, json={"id": "t-1"})
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
        }
    )

    stl = provider.generate_stl("job-1", _values(), desc)

    assert stl  # real (mocked) STL bytes came back
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
        }
    )

    provider.generate_stl("job-1", _values(), desc)

    sent_names = {item["name"] for item in captured["variables_body"]["items"]}  # type: ignore[index]
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
        }
    )
    with pytest.raises(DescriptorError, match="missing required id"):
        provider.generate_stl("job-1", _values(), desc)


def test_onshape_provider_dry_run_without_credentials() -> None:
    # No credentials -> OnshapeClient.dry_run -> canned STL, no network calls.
    provider = OnshapeProvider(settings=Settings())
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": "d", "workspace_id": "w", "element_id": "e"},
            "variable_map": None,
        }
    )
    stl = provider.generate_stl("job-1", _values(), desc)
    assert stl  # canned dry-run bytes, no exception


# ---------------------------------------------------------------------------
# Dispatcher: resolution + fallback default
# ---------------------------------------------------------------------------


def test_default_descriptor_is_dry_run_without_credentials() -> None:
    desc = default_descriptor(Settings())
    assert desc.provider == "dry_run"
    assert desc.schema_version == SCHEMA_VERSION


def test_default_descriptor_is_onshape_with_credentials() -> None:
    desc = default_descriptor(_configured_settings())
    assert desc.provider == "onshape"
    assert desc.ref["document_id"] == "settings-doc"


def test_resolve_descriptor_falls_back_when_none() -> None:
    desc = resolve_descriptor(None, Settings())
    assert desc.provider == "dry_run"


def test_resolve_descriptor_parses_stored_dict() -> None:
    desc = resolve_descriptor(_good_descriptor_dict(), Settings())
    assert desc.provider == "onshape"


def test_dispatcher_run_returns_stl_and_logs_latency(caplog: pytest.LogCaptureFixture) -> None:
    dispatcher = CadDispatcher(settings=Settings())
    with caplog.at_level("INFO"):
        stl = dispatcher.run("job-1", _values(), None)  # None -> dry-run default
    assert stl == DRY_RUN_STL
    assert any(
        "cad generation complete" in rec.message and "job-1" in rec.message
        for rec in caplog.records
    )
