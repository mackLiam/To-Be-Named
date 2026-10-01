"""Onshape REST client.

Owns the single canonical-units boundary for the whole pipeline
(docs/DESIGN.md gotcha #1): the rest of the worker computes exclusively in
millimeters, and `mm_to_m` converts to meters exactly once, right before the
values are sent to Onshape. No other module in this codebase should ever
perform a unit conversion on measurement values.

Two ways to drive a model, chosen by the descriptor's variable_kind:
- part_studio_features (default): copy a TEMPLATE document per job, rewrite
  its Part Studio Variable features, check regeneration, export, delete the
  copy (`generate_from_template`).
- variable_studio: write a Variable Studio in place (`set_variables`), then
  export (`export_stl`).

DRY_RUN mode: when no Onshape credentials are configured (see
`Settings.dry_run`), methods log the call they would have made and return
canned results instead of touching the network.

Retriability is decided here, at the raise site: OnshapeError is presumed
transient (429/5xx/timeouts, after tenacity backoff is exhausted);
OnshapeRejectedError means the same input will never succeed (other 4xx, a
template missing variables, values that break regeneration).
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from forms_pipeline.config import Settings, get_settings
from forms_pipeline.contract import MEASUREMENT_KEYS

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RETRY_ATTEMPTS = 4

_RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})

DRY_RUN_STL = b"solid dry_run\nendsolid dry_run\n"

# assignVariable value parameter per variableType. NUMBER/ANGLE variables
# cannot hold a length measurement, so they are rejected rather than written.
_VALUE_PARAM_BY_TYPE = {"LENGTH": "lengthValue", "ANY": "anyValue"}
_VALUE_PARAM_FALLBACK = ("lengthValue", "anyValue")


class OnshapeError(RuntimeError):
    """Presumed transient: an Onshape call failed after exhausting retries."""


class OnshapeRejectedError(OnshapeError):
    """Non-retriable: Onshape rejected the request or the model cannot take these values."""


@dataclass(frozen=True)
class OnshapeRef:
    """Identifies the Onshape document/workspace/element a client targets.

    For part_studio_features this is the TEMPLATE; job copies are resolved
    at generate time.
    """

    document_id: str
    workspace_id: str
    element_id: str


def mm_to_m(values: dict[str, float]) -> dict[str, float]:
    """Pure unit conversion: millimeters to meters. The one and only place this happens.

    Deliberately has no side effects and no knowledge of Onshape's HTTP API,
    so it can be tested and reasoned about in isolation from network
    concerns.
    """
    return {key: value / 1000.0 for key, value in values.items()}


def _is_retryable_http_error(exc: BaseException) -> bool:
    """Retry on transient failures only: rate limits/5xx and connection-level errors."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _RETRYABLE_STATUS_CODES
    return isinstance(exc, httpx.TransportError)


def _model_values_m(
    values_mm: dict[str, float], variable_map: dict[str, str] | None
) -> dict[str, float]:
    """The 25 values keyed by model variable name, in meters."""
    missing = set(MEASUREMENT_KEYS) - values_mm.keys()
    if missing:
        raise OnshapeRejectedError(f"missing required variables: {sorted(missing)}")
    mapping = variable_map or {}
    values_m = mm_to_m({key: values_mm[key] for key in MEASUREMENT_KEYS})
    return {mapping.get(key, key): value for key, value in values_m.items()}


def _param(feature: dict[str, Any], parameter_id: str) -> dict[str, Any] | None:
    for param in feature.get("parameters", []):
        if param.get("parameterId") == parameter_id:
            return param
    return None


def variable_features(features: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Map variable name -> assignVariable feature. A name assigned twice is ambiguous."""
    by_name: dict[str, dict[str, Any]] = {}
    for feature in features:
        if feature.get("featureType") != "assignVariable":
            continue
        name_param = _param(feature, "name")
        name = name_param.get("value") if name_param else None
        if not name:
            continue
        if name in by_name:
            raise OnshapeRejectedError(f"template assigns variable {name!r} more than once")
        by_name[name] = feature
    return by_name


def _value_param(feature: dict[str, Any], name: str) -> dict[str, Any]:
    type_param = _param(feature, "variableType")
    variable_type = type_param.get("value") if type_param else None
    if variable_type is not None and variable_type not in _VALUE_PARAM_BY_TYPE:
        raise OnshapeRejectedError(
            f"template variable {name!r} has type {variable_type}, expected LENGTH or ANY"
        )
    for parameter_id in (_VALUE_PARAM_BY_TYPE.get(variable_type), *_VALUE_PARAM_FALLBACK):
        param = _param(feature, parameter_id) if parameter_id else None
        if param is not None:
            return param
    raise OnshapeRejectedError(f"template variable {name!r} has no value parameter")


def build_feature_updates(
    features: list[dict[str, Any]], values_m: dict[str, float]
) -> list[dict[str, Any]]:
    """Copies of the variable features with each value expression set in meters."""
    by_name = variable_features(features)
    missing = sorted(set(values_m) - by_name.keys())
    if missing:
        raise OnshapeRejectedError(f"template is missing variable feature(s): {missing}")
    updates = []
    for name, meters in values_m.items():
        feature = copy.deepcopy(by_name[name])
        _value_param(feature, name)["expression"] = f"{meters} m"
        updates.append(feature)
    return updates


def failing_feature_names(features_response: dict[str, Any]) -> list[str]:
    """Names of features whose regeneration status is not OK."""
    names = {f.get("featureId"): f.get("name") for f in features_response.get("features", [])}
    return sorted(
        names.get(feature_id) or feature_id
        for feature_id, state in features_response.get("featureStates", {}).items()
        if state.get("featureStatus") != "OK"
    )


def _ps_path(document_id: str, workspace_id: str, element_id: str) -> str:
    return f"/api/v6/partstudios/d/{document_id}/w/{workspace_id}/e/{element_id}"


class OnshapeClient:
    """Thin client over the Onshape REST API for one parametric model ref.

    `job_id` is threaded through every method for log/error traceability and
    names the per-job document copy.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        client: httpx.Client | None = None,
        ref: OnshapeRef | None = None,
    ):
        self._settings = settings or get_settings()
        self.dry_run = self._settings.dry_run
        self._ref = ref or OnshapeRef(
            document_id=self._settings.onshape_document_id,
            workspace_id=self._settings.onshape_workspace_id,
            element_id=self._settings.onshape_element_id,
        )
        if self._ref.document_id in self._settings.protected_document_ids:
            raise OnshapeRejectedError(
                f"Onshape document {self._ref.document_id} is protected; point the "
                "pipeline at a template copy instead"
            )
        self._client = client or httpx.Client(
            base_url=self._settings.onshape_base_url,
            timeout=REQUEST_TIMEOUT_SECONDS,
            auth=(
                None
                if self.dry_run
                else (
                    self._settings.onshape_access_key.get_secret_value(),
                    self._settings.onshape_secret_key.get_secret_value(),
                )
            ),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> OnshapeClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @retry(
        reraise=True,
        stop=stop_after_attempt(MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=0.5, max=8),
        retry=retry_if_exception(_is_retryable_http_error),
    )
    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        response = self._client.request(method, path, **kwargs)
        response.raise_for_status()
        return response

    @staticmethod
    def _wrap(job_id: str, action: str, exc: httpx.HTTPError) -> OnshapeError:
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            cls = OnshapeError if status in _RETRYABLE_STATUS_CODES else OnshapeRejectedError
            return cls(f"job={job_id}: {action} failed: HTTP {status}")
        return OnshapeError(f"job={job_id}: {action} failed: {type(exc).__name__}")

    def _call(self, job_id: str, action: str, method: str, path: str, **kwargs: Any) -> Any:
        try:
            return self._request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise self._wrap(job_id, action, exc) from exc

    def _json(self, job_id: str, action: str, method: str, path: str, **kwargs: Any) -> Any:
        return self._call(job_id, action, method, path, **kwargs).json()

    # -- variable_studio -----------------------------------------------------

    def set_variables(
        self,
        job_id: str,
        values_mm: dict[str, float],
        variable_map: dict[str, str] | None = None,
    ) -> None:
        """Write the 25 variables to a Variable Studio element, as meter expressions."""
        values_m = _model_values_m(values_mm, variable_map)
        r = self._ref
        path = f"/api/v6/variables/d/{r.document_id}/w/{r.workspace_id}/e/{r.element_id}/variables"
        payload = [
            {"type": "LENGTH", "name": name, "expression": f"{meters} m"}
            for name, meters in values_m.items()
        ]
        if self.dry_run:
            logger.info(
                "[DRY_RUN] job=%s would POST %s with %d variables", job_id, path, len(payload)
            )
            return
        self._call(job_id, "set Onshape variables", "POST", path, json=payload)

    def export_stl(self, job_id: str) -> bytes:
        """Export STL bytes for the ref's part studio."""
        if self.dry_run:
            logger.info("[DRY_RUN] job=%s would export STL from Onshape", job_id)
            return DRY_RUN_STL
        r = self._ref
        return self._export(job_id, r.document_id, r.workspace_id, r.element_id)

    def _export(self, job_id: str, document_id: str, workspace_id: str, element_id: str) -> bytes:
        # No partId: a multi-part studio exports every part into one STL.
        # Onshape answers with a 307 to the file, hence follow_redirects.
        response = self._call(
            job_id,
            "export STL",
            "GET",
            f"{_ps_path(document_id, workspace_id, element_id)}/stl",
            params={"mode": "binary", "units": "millimeter"},
            headers={"Accept": "application/octet-stream"},
            follow_redirects=True,
        )
        return response.content

    # -- part_studio_features (template copy per job) ------------------------

    def generate_from_template(
        self,
        job_id: str,
        values_mm: dict[str, float],
        variable_map: dict[str, str] | None = None,
    ) -> tuple[bytes, dict[str, Any]]:
        """Copy the template, write the 25 variables, verify regen, export, clean up.

        Returns (stl_bytes, artifacts). The copy is deleted in all outcomes
        unless settings.onshape_keep_job_documents; a public copy is deleted
        regardless, since job documents hold customer body measurements.
        """
        values_m = _model_values_m(values_mm, variable_map)
        t = self._ref
        artifacts: dict[str, Any] = {
            "template_document_id": t.document_id,
            "template_workspace_id": t.workspace_id,
            "template_element_id": t.element_id,
        }
        if self.dry_run:
            logger.info("[DRY_RUN] job=%s would generate from template %s", job_id, t.document_id)
            return DRY_RUN_STL, {**artifacts, "dry_run": True}

        template = self._json(
            job_id,
            "read template features",
            "GET",
            f"{_ps_path(t.document_id, t.workspace_id, t.element_id)}/features",
        )
        build_feature_updates(template.get("features", []), values_m)
        artifacts["template_microversion"] = template.get("sourceMicroversion")
        element_name = self._element_name(job_id, t.document_id, t.workspace_id, t.element_id)

        copied = self._json(
            job_id,
            "copy template document",
            "POST",
            f"/api/v6/documents/{t.document_id}/workspaces/{t.workspace_id}/copy",
            json={"newName": f"FORMS job {job_id}", "isPublic": False},
        )
        did, wid = copied["newDocumentId"], copied["newWorkspaceId"]
        keep = self._settings.onshape_keep_job_documents
        artifacts.update(job_document_id=did, job_workspace_id=wid, job_document_kept=keep)

        deleted = False
        try:
            document = self._json(job_id, "read job document", "GET", f"/api/v6/documents/{did}")
            if document.get("public") and not self._settings.onshape_allow_public_job_documents:
                self._delete_document(job_id, did)
                deleted = True
                artifacts["job_document_kept"] = False
                raise OnshapeRejectedError(
                    f"job={job_id}: the Onshape plan created the job document as public, and "
                    "job documents hold customer body measurements; deleted it. Use a plan "
                    "with private documents or set ONSHAPE_ALLOW_PUBLIC_JOB_DOCUMENTS."
                )

            eid = self._element_id_by_name(job_id, did, wid, element_name)
            artifacts["job_element_id"] = eid
            path = _ps_path(did, wid, eid)

            current = self._json(job_id, "read job features", "GET", f"{path}/features")
            self._call(
                job_id,
                "write variable features",
                "POST",
                f"{path}/features/updates",
                json={
                    "btType": "BTUpdateFeaturesCall-1748",
                    "features": build_feature_updates(current.get("features", []), values_m),
                    "serializationVersion": current.get("serializationVersion"),
                    "sourceMicroversion": current.get("sourceMicroversion"),
                },
            )

            regenerated = self._json(job_id, "read regenerated features", "GET", f"{path}/features")
            failing = failing_feature_names(regenerated)
            if failing:
                raise OnshapeRejectedError(
                    f"job={job_id}: model failed to regenerate with these measurements; "
                    f"failing features: {failing}"
                )
            parts = self._json(
                job_id, "list parts", "GET", f"/api/v6/parts/d/{did}/w/{wid}/e/{eid}"
            )
            if not parts:
                raise OnshapeRejectedError(f"job={job_id}: regenerated model has no parts")
            artifacts["part_count"] = len(parts)

            stl_bytes = self._export(job_id, did, wid, eid)
        except BaseException:
            # A cleanup error must not mask the original failure.
            if not keep and not deleted:
                try:
                    self._delete_document(job_id, did)
                except OnshapeError:
                    logger.exception("job=%s: failed to delete job document %s", job_id, did)
            raise
        if not keep:
            # Propagates (retriable) so a copy holding measurements is never silently left behind.
            self._delete_document(job_id, did)
        return stl_bytes, artifacts

    def _element_name(self, job_id: str, did: str, wid: str, eid: str) -> str:
        for element in self._part_studios(job_id, did, wid):
            if element.get("id") == eid:
                return str(element.get("name"))
        raise OnshapeRejectedError(f"template part studio element {eid} not found")

    def _element_id_by_name(self, job_id: str, did: str, wid: str, name: str) -> str:
        matches = [e for e in self._part_studios(job_id, did, wid) if e.get("name") == name]
        if len(matches) != 1:
            raise OnshapeRejectedError(
                f"job={job_id}: expected one part studio named {name!r} in the copy, "
                f"found {len(matches)}"
            )
        return str(matches[0]["id"])

    def _part_studios(self, job_id: str, did: str, wid: str) -> list[dict[str, Any]]:
        return self._json(
            job_id,
            "list part studios",
            "GET",
            f"/api/v6/documents/d/{did}/w/{wid}/elements",
            params={"elementType": "PARTSTUDIO"},
        )

    def _delete_document(self, job_id: str, did: str) -> None:
        """Idempotent: an already-deleted document (404) counts as deleted."""
        if did in self._settings.protected_document_ids:
            raise OnshapeRejectedError(f"job={job_id}: refusing to delete protected document {did}")
        try:
            self._request("DELETE", f"/api/v6/documents/{did}")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise self._wrap(job_id, "delete job document", exc) from exc
        except httpx.HTTPError as exc:
            raise self._wrap(job_id, "delete job document", exc) from exc
