"""Template-copy flow (variable_kind part_studio_features) against a fake Onshape."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from forms_pipeline.cad.model import CadModelDescriptor
from forms_pipeline.cad.providers import OnshapeProvider
from forms_pipeline.config import Settings
from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA_VERSION
from forms_pipeline.onshape.client import (
    OnshapeClient,
    OnshapeError,
    OnshapeRef,
    OnshapeRejectedError,
)

_FAKE_SECRET = "test-secret"  # noqa: S105 - test fixture value, not a real secret

T_DID, T_WID, T_EID = (
    "dd00f51969160b5169ebfe7a",
    "07eca1fa64665e68debcd3e1",
    "4a99194b696ca5aef61427de",
)
J_DID, J_WID, J_EID = (
    "job0doc0000000000000000",
    "job0ws00000000000000000",
    "job0el00000000000000000",
)
ELEMENT_NAME = "MVP 1"
STL = b"\x00" * 80 + b"\x01\x00\x00\x00" + b"\x00" * 50
EXTRA_VARIABLES = ("Shell_Thickness", "EVA_Thickness", "Fit_Clearance")


def _var_feature(
    fid: str, name: str, value_param: str = "lengthValue", vtype: str | None = "LENGTH"
) -> dict[str, Any]:
    params: list[dict[str, Any]] = [
        {"btType": "BTMParameterString-149", "parameterId": "name", "value": name},
        {
            "btType": "BTMParameterQuantity-147",
            "parameterId": value_param,
            "expression": "15 mm",
            "isInteger": False,
            "units": "",
            "value": 0.0,
        },
        {"btType": "BTMParameterString-149", "parameterId": "description", "value": ""},
    ]
    if vtype is not None:
        params.insert(
            0,
            {
                "btType": "BTMParameterEnum-145",
                "parameterId": "variableType",
                "enumName": "VariableType",
                "value": vtype,
            },
        )
    return {
        "btType": "BTMFeature-134",
        "featureType": "assignVariable",
        "featureId": fid,
        "name": f"Variable {fid}",
        "namespace": "",
        "suppressed": False,
        "parameters": params,
    }


def _features(names: list[str], **overrides: dict[str, Any]) -> list[dict[str, Any]]:
    features = [overrides.get(name) or _var_feature(f"F{i}", name) for i, name in enumerate(names)]
    features.append(
        {
            "btType": "BTMFeature-134",
            "featureType": "extrude",
            "featureId": "FEXT",
            "name": "Shell extrude",
            "parameters": [],
        }
    )
    return features


def _features_response(
    features: list[dict[str, Any]], microversion: str, failing: tuple[str, ...] = ()
) -> dict[str, Any]:
    return {
        "btType": "BTFeatureListResponse-2457",
        "features": features,
        "defaultFeatures": [],
        "imports": [],
        "featureStates": {
            f["featureId"]: {
                "btType": "BTFeatureState-1688",
                "featureStatus": "ERROR" if f["featureId"] in failing else "OK",
            }
            for f in features
        },
        "serializationVersion": "1.2.5",
        "sourceMicroversion": microversion,
        "rollbackIndex": len(features),
        "libraryVersion": 2349,
        "microversionSkew": False,
        "rejectMicroversionSkew": False,
    }


class FakeOnshape:
    """Routes the template flow's endpoints; per-test knobs tweak responses."""

    def __init__(self) -> None:
        names = list(MEASUREMENT_KEYS) + list(EXTRA_VARIABLES)
        self.template_features = _features(names)
        self.job_features = _features(names)
        self.public = False
        self.failing_after_update: tuple[str, ...] = ()
        self.parts: list[dict[str, Any]] = [{"partId": "JHD", "name": "Part 1"}]
        self.delete_status = 200
        self.stl_status = 200
        self.copy_statuses: list[int] = []
        self.requests: list[httpx.Request] = []
        self.update_body: dict[str, Any] | None = None

    def calls(self, method: str, path: str) -> int:
        return sum(1 for r in self.requests if r.method == method and r.url.path == path)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, request.url.path)
        t_ps = f"/api/v6/partstudios/d/{T_DID}/w/{T_WID}/e/{T_EID}"
        j_ps = f"/api/v6/partstudios/d/{J_DID}/w/{J_WID}/e/{J_EID}"
        routes = {
            ("GET", f"{t_ps}/features"): lambda: httpx.Response(
                200, json=_features_response(self.template_features, "mv-template")
            ),
            ("GET", f"/api/v6/documents/d/{T_DID}/w/{T_WID}/elements"): lambda: httpx.Response(
                200,
                json=[
                    {"id": "other", "name": "Sketches", "elementType": "PARTSTUDIO"},
                    {"id": T_EID, "name": ELEMENT_NAME, "elementType": "PARTSTUDIO"},
                ],
            ),
            ("POST", f"/api/v6/documents/{T_DID}/workspaces/{T_WID}/copy"): self._copy,
            ("GET", f"/api/v6/documents/{J_DID}"): lambda: httpx.Response(
                200, json={"id": J_DID, "name": "FORMS job job-1", "public": self.public}
            ),
            ("GET", f"/api/v6/documents/d/{J_DID}/w/{J_WID}/elements"): lambda: httpx.Response(
                200, json=[{"id": J_EID, "name": ELEMENT_NAME, "elementType": "PARTSTUDIO"}]
            ),
            ("GET", f"{j_ps}/features"): self._job_features,
            ("POST", f"{j_ps}/features/updates"): self._update,
            ("GET", f"/api/v6/parts/d/{J_DID}/w/{J_WID}/e/{J_EID}"): lambda: httpx.Response(
                200, json=self.parts
            ),
            ("GET", f"{j_ps}/stl"): lambda: (
                httpx.Response(307, headers={"Location": "/api/v6/blob/stl-download-1"})
                if self.stl_status == 200
                else httpx.Response(self.stl_status)
            ),
            ("GET", "/api/v6/blob/stl-download-1"): lambda: httpx.Response(200, content=STL),
            ("DELETE", f"/api/v6/documents/{J_DID}"): lambda: httpx.Response(self.delete_status),
        }
        if key not in routes:
            raise AssertionError(f"unexpected request {key}")
        return routes[key]()

    def _copy(self) -> httpx.Response:
        if self.copy_statuses:
            return httpx.Response(self.copy_statuses.pop(0))
        return httpx.Response(200, json={"newDocumentId": J_DID, "newWorkspaceId": J_WID})

    def _job_features(self) -> httpx.Response:
        if self.update_body is None:
            return httpx.Response(200, json=_features_response(self.job_features, "mv-job-1"))
        return httpx.Response(
            200,
            json=_features_response(self.job_features, "mv-job-2", self.failing_after_update),
        )

    def _update(self) -> httpx.Response:
        self.update_body = json.loads(self.requests[-1].content)
        return httpx.Response(200, json={"features": [], "sourceMicroversion": "mv-job-2"})


def _settings(**overrides: Any) -> Settings:
    return Settings(
        _env_file=None,
        onshape_access_key="test-access",
        onshape_secret_key=_FAKE_SECRET,
        onshape_allow_public_job_documents=overrides.get("allow_public", False),
        onshape_keep_job_documents=overrides.get("keep", False),
    )


def _client(fake: FakeOnshape, **overrides: Any) -> OnshapeClient:
    settings = _settings(**overrides)
    http = httpx.Client(
        transport=httpx.MockTransport(fake.handler), base_url=settings.onshape_base_url
    )
    return OnshapeClient(settings=settings, client=http, ref=OnshapeRef(T_DID, T_WID, T_EID))


def _values() -> dict[str, float]:
    return {key: 10.0 + i for i, key in enumerate(MEASUREMENT_KEYS)}


def _expressions(body: dict[str, Any]) -> dict[str, str]:
    out = {}
    for feature in body["features"]:
        params = {p["parameterId"]: p for p in feature["parameters"]}
        value = params.get("lengthValue") or params.get("anyValue")
        out[params["name"]["value"]] = value["expression"]
    return out


JOB_DELETE = ("DELETE", f"/api/v6/documents/{J_DID}")
COPY = ("POST", f"/api/v6/documents/{T_DID}/workspaces/{T_WID}/copy")


def test_happy_path_writes_meters_in_one_batch_and_cleans_up() -> None:
    fake = FakeOnshape()
    stl, artifacts = _client(fake).generate_from_template("job-1", _values())

    assert stl == STL
    body = fake.update_body
    assert body is not None
    assert body["btType"] == "BTUpdateFeaturesCall-1748"
    assert body["serializationVersion"] == "1.2.5"
    # From the fresh GET in the copy, not the template.
    assert body["sourceMicroversion"] == "mv-job-1"
    expected = {key: f"{(10.0 + i) / 1000.0} m" for i, key in enumerate(MEASUREMENT_KEYS)}
    assert _expressions(body) == expected
    assert expected[MEASUREMENT_KEYS[5]] == "0.015 m"
    assert not set(EXTRA_VARIABLES) & set(_expressions(body))
    assert (
        fake.calls("POST", f"/api/v6/partstudios/d/{J_DID}/w/{J_WID}/e/{J_EID}/features/updates")
        == 1
    )

    copy_request = next(r for r in fake.requests if (r.method, r.url.path) == COPY)
    assert json.loads(copy_request.content) == {"newName": "FORMS job job-1", "isPublic": False}

    stl_request = next(r for r in fake.requests if r.url.path.endswith("/stl"))
    assert stl_request.url.params["mode"] == "binary"
    assert stl_request.url.params["units"] == "millimeter"
    assert "partId" not in stl_request.url.params
    assert stl_request.headers["Accept"] == "application/octet-stream"

    assert fake.calls(*JOB_DELETE) == 1
    assert artifacts == {
        "template_document_id": T_DID,
        "template_workspace_id": T_WID,
        "template_element_id": T_EID,
        "template_microversion": "mv-template",
        "job_document_id": J_DID,
        "job_workspace_id": J_WID,
        "job_element_id": J_EID,
        "job_document_kept": False,
        "part_count": 1,
    }


def test_multi_part_studio_records_part_count() -> None:
    fake = FakeOnshape()
    fake.parts = [{"partId": "A"}, {"partId": "B"}]
    _, artifacts = _client(fake).generate_from_template("job-1", _values())
    assert artifacts["part_count"] == 2


def test_variable_map_renames_written_variables() -> None:
    fake = FakeOnshape()
    renamed = MEASUREMENT_KEYS[0]
    names = ["Model_Var_0", *MEASUREMENT_KEYS[1:]]
    fake.template_features = _features(names)
    fake.job_features = _features(names)
    _client(fake).generate_from_template("job-1", _values(), {renamed: "Model_Var_0"})
    assert fake.update_body is not None
    written = set(_expressions(fake.update_body))
    assert written == {"Model_Var_0", *MEASUREMENT_KEYS[1:]}


def test_template_missing_variable_is_rejected_before_copy() -> None:
    fake = FakeOnshape()
    missing = MEASUREMENT_KEYS[3]
    fake.template_features = _features([k for k in MEASUREMENT_KEYS if k != missing])
    with pytest.raises(OnshapeRejectedError, match=missing):
        _client(fake).generate_from_template("job-1", _values())
    assert fake.calls(*COPY) == 0


def test_value_param_falls_back_to_any_value() -> None:
    fake = FakeOnshape()
    name = MEASUREMENT_KEYS[0]
    any_feature = _var_feature("F0", name, value_param="anyValue", vtype=None)
    fake.template_features = _features(list(MEASUREMENT_KEYS), **{name: any_feature})
    fake.job_features = _features(list(MEASUREMENT_KEYS), **{name: any_feature})
    _client(fake).generate_from_template("job-1", _values())
    assert fake.update_body is not None
    feature = next(f for f in fake.update_body["features"] if f["featureId"] == "F0")
    params = {p["parameterId"]: p for p in feature["parameters"]}
    assert params["anyValue"]["expression"] == "0.01 m"


@pytest.mark.parametrize(
    ("value_param", "vtype", "match"),
    [("description2", None, "no value parameter"), ("numberValue", "NUMBER", "type NUMBER")],
)
def test_unwritable_variable_is_rejected(value_param: str, vtype: str | None, match: str) -> None:
    fake = FakeOnshape()
    name = MEASUREMENT_KEYS[0]
    bad = _var_feature("F0", name, value_param=value_param, vtype=vtype)
    fake.template_features = _features(list(MEASUREMENT_KEYS), **{name: bad})
    with pytest.raises(OnshapeRejectedError, match=match):
        _client(fake).generate_from_template("job-1", _values())


def test_regeneration_failure_is_rejected_and_copy_deleted() -> None:
    fake = FakeOnshape()
    fake.failing_after_update = ("FEXT",)
    with pytest.raises(OnshapeRejectedError, match="Shell extrude"):
        _client(fake).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 1


def test_no_parts_after_regeneration_is_rejected() -> None:
    fake = FakeOnshape()
    fake.parts = []
    with pytest.raises(OnshapeRejectedError, match="no parts"):
        _client(fake).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 1


def test_public_copy_is_deleted_and_rejected_even_with_keep_flag() -> None:
    fake = FakeOnshape()
    fake.public = True
    with pytest.raises(OnshapeRejectedError, match="public"):
        _client(fake, keep=True).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 1
    assert fake.update_body is None


def test_public_copy_allowed_by_flag() -> None:
    fake = FakeOnshape()
    fake.public = True
    stl, _ = _client(fake, allow_public=True).generate_from_template("job-1", _values())
    assert stl == STL


def test_keep_flag_skips_delete() -> None:
    fake = FakeOnshape()
    _, artifacts = _client(fake, keep=True).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 0
    assert artifacts["job_document_kept"] is True


def test_keep_flag_skips_delete_on_failure() -> None:
    fake = FakeOnshape()
    fake.parts = []
    with pytest.raises(OnshapeRejectedError):
        _client(fake, keep=True).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 0


def test_rate_limit_is_retried_then_succeeds() -> None:
    fake = FakeOnshape()
    fake.copy_statuses = [429]
    stl, _ = _client(fake).generate_from_template("job-1", _values())
    assert stl == STL
    assert fake.calls(*COPY) == 2


def test_client_error_after_copy_is_rejected_and_cleaned_up() -> None:
    fake = FakeOnshape()
    fake.stl_status = 400
    with pytest.raises(OnshapeRejectedError, match="HTTP 400"):
        _client(fake).generate_from_template("job-1", _values())
    assert fake.calls(*JOB_DELETE) == 1


def test_cleanup_error_does_not_mask_original_failure() -> None:
    fake = FakeOnshape()
    fake.stl_status = 400
    fake.delete_status = 403
    with pytest.raises(OnshapeRejectedError, match="export STL"):
        _client(fake).generate_from_template("job-1", _values())


def test_delete_404_counts_as_deleted() -> None:
    fake = FakeOnshape()
    fake.delete_status = 404
    stl, _ = _client(fake).generate_from_template("job-1", _values())
    assert stl == STL


def test_delete_failure_on_success_path_is_raised() -> None:
    fake = FakeOnshape()
    fake.delete_status = 403
    with pytest.raises(OnshapeRejectedError, match="delete job document"):
        _client(fake).generate_from_template("job-1", _values())


def test_server_error_exhausts_retries_as_retriable() -> None:
    fake = FakeOnshape()
    fake.copy_statuses = [503] * 10
    with pytest.raises(OnshapeError) as info:
        _client(fake).generate_from_template("job-1", _values())
    assert not isinstance(info.value, OnshapeRejectedError)


def test_dry_run_makes_no_calls_and_returns_template_artifacts() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("dry-run mode must not make network calls")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = OnshapeClient(
        settings=Settings(_env_file=None), client=http, ref=OnshapeRef(T_DID, T_WID, T_EID)
    )
    stl, artifacts = client.generate_from_template("job-1", _values())
    assert stl
    assert artifacts["dry_run"] is True
    assert artifacts["template_document_id"] == T_DID


def test_provider_returns_cad_result_with_artifacts() -> None:
    fake = FakeOnshape()
    settings = _settings()
    http = httpx.Client(
        transport=httpx.MockTransport(fake.handler), base_url=settings.onshape_base_url
    )
    desc = CadModelDescriptor.parse(
        {
            "provider": "onshape",
            "schema_version": SCHEMA_VERSION,
            "ref": {"document_id": T_DID, "workspace_id": T_WID, "element_id": T_EID},
        }
    )
    assert desc.variable_kind == "part_studio_features"
    result = OnshapeProvider(settings=settings, http_client=http).generate_stl(
        "job-1", _values(), desc
    )
    assert result.stl_bytes == STL
    assert result.artifacts["job_document_id"] == J_DID
