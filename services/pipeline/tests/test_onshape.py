from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from forms_pipeline.config import Settings
from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.onshape.client import (
    MAX_RETRY_ATTEMPTS,
    OnshapeClient,
    OnshapeError,
    OnshapeRef,
    OnshapeRejectedError,
    mm_to_m,
)

_FAKE_SECRET = "test-secret"  # noqa: S105 - test fixture value, not a real secret


def _configured_settings() -> Settings:
    return Settings(
        _env_file=None,
        onshape_access_key="test-access",
        onshape_secret_key=_FAKE_SECRET,
        onshape_document_id="doc",
        onshape_workspace_id="ws",
        onshape_element_id="el",
    )


def _client_with_transport(
    settings: Settings, handler: Callable[[httpx.Request], httpx.Response]
) -> OnshapeClient:
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport, base_url=settings.onshape_base_url)
    return OnshapeClient(settings=settings, client=http_client)


def test_mm_to_m_exact_conversion() -> None:
    assert mm_to_m({"Leg_Length": 1000.0, "S1_OW": 250.0}) == {
        "Leg_Length": 1.0,
        "S1_OW": 0.25,
    }


def test_mm_to_m_does_not_mutate_input() -> None:
    values = {"Leg_Length": 500.0}
    mm_to_m(values)
    assert values == {"Leg_Length": 500.0}


def test_set_variables_payload_has_all_25_names_spelled_exactly() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client = _client_with_transport(_configured_settings(), handler)
    values = {key: 100.0 for key in MEASUREMENT_KEYS}
    client.set_variables("job-1", values)

    sent_names = {item["name"] for item in captured["body"]}
    assert sent_names == set(MEASUREMENT_KEYS)


def test_set_variables_converts_to_meters_in_payload() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client = _client_with_transport(_configured_settings(), handler)
    values = {key: 1000.0 for key in MEASUREMENT_KEYS}
    client.set_variables("job-1", values)

    assert {item["expression"] for item in captured["body"]} == {"1.0 m"}
    assert {item["type"] for item in captured["body"]} == {"LENGTH"}


def test_dry_run_makes_no_network_calls() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("dry-run mode must not make network calls")

    settings = Settings(_env_file=None)  # no Onshape credentials configured -> dry_run True
    client = _client_with_transport(settings, handler)

    assert client.dry_run is True
    client.set_variables("job-1", {key: 1.0 for key in MEASUREMENT_KEYS})
    stl_bytes = client.export_stl("job-1")
    assert stl_bytes  # canned bytes, no exception


def test_retry_gives_up_after_bound() -> None:
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(500)

    client = _client_with_transport(_configured_settings(), handler)

    with pytest.raises(OnshapeError) as info:
        client.set_variables("job-1", {key: 1.0 for key in MEASUREMENT_KEYS})

    assert not isinstance(info.value, OnshapeRejectedError)
    assert call_count["n"] == MAX_RETRY_ATTEMPTS


def test_non_retryable_status_fails_fast() -> None:
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(400)

    client = _client_with_transport(_configured_settings(), handler)

    with pytest.raises(OnshapeRejectedError):
        client.set_variables("job-1", {key: 1.0 for key in MEASUREMENT_KEYS})

    assert call_count["n"] == 1


def test_set_variables_rejects_missing_keys() -> None:
    client = _client_with_transport(_configured_settings(), lambda r: httpx.Response(200, json={}))
    with pytest.raises(OnshapeRejectedError, match="missing"):
        client.set_variables("job-1", {"Leg_Length": 300.0})


def test_export_stl_follows_redirect_in_millimeters() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/stl"):
            return httpx.Response(307, headers={"Location": "/api/v6/blob/stl-1"})
        return httpx.Response(200, content=b"binary-stl")

    client = _client_with_transport(_configured_settings(), handler)
    assert client.export_stl("job-1") == b"binary-stl"
    assert seen[0].url.path == "/api/v6/partstudios/d/doc/w/ws/e/el/stl"
    assert seen[0].url.params["units"] == "millimeter"
    assert seen[0].url.params["mode"] == "binary"
    assert seen[1].url.path == "/api/v6/blob/stl-1"


def test_protected_document_cannot_be_targeted() -> None:
    settings = _configured_settings()
    settings.onshape_protected_document_ids = "mvp, other"
    with pytest.raises(OnshapeRejectedError, match="protected"):
        OnshapeClient(settings=settings, ref=OnshapeRef("mvp", "ws", "el"))


def test_protected_document_is_never_deleted() -> None:
    settings = _configured_settings()
    settings.onshape_protected_document_ids = "mvp"
    calls: list[httpx.Request] = []
    client = _client_with_transport(settings, lambda r: calls.append(r) or httpx.Response(200))
    with pytest.raises(OnshapeRejectedError, match="protected"):
        client._delete_document("job-1", "mvp")
    assert calls == []
