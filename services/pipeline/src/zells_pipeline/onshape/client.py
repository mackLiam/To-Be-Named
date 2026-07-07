"""Onshape REST client.

Owns the single canonical-units boundary for the whole pipeline
(docs/DESIGN.md gotcha #1): the rest of the worker computes exclusively in
millimeters, and `mm_to_m` converts to meters exactly once, right before the
values are sent to Onshape's variables API. No other module in this
codebase should ever perform a unit conversion on measurement values.

DRY_RUN mode: when no Onshape credentials are configured (the default in
development, see `Settings.dry_run`), every method logs the call it would
have made and returns a canned result instead of touching the network. This
lets Phase 0 plumbing (queue -> extraction -> "CAD" -> "STL" -> advance) be
exercised end to end without an Onshape account.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from zells_pipeline.config import Settings, get_settings
from zells_pipeline.contract import MEASUREMENT_KEYS

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RETRY_ATTEMPTS = 4

_RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


class OnshapeError(RuntimeError):
    """Raised when an Onshape API call fails after exhausting retries."""


@dataclass(frozen=True)
class OnshapeRef:
    """Identifies the specific Onshape document/workspace/element a client targets.

    Pulled out of Settings so a single worker can drive many different
    parametric models (one per guard design) instead of the one document
    baked into env config: each CAD model descriptor (docs/DESIGN.md
    section 7) carries its own ref, resolved into this at generate time.
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
    """Retry on transient failures only: rate limits/5xx and connection-level errors.

    A 4xx other than 429 (e.g. bad request, auth failure) will not succeed
    on retry, so it is deliberately excluded and surfaces immediately.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _RETRYABLE_STATUS_CODES
    return isinstance(exc, httpx.TransportError)


class OnshapeClient:
    """Thin client over the Onshape REST API for one shin-guard parametric document.

    Every public method accepts `job_id` purely for logging/idempotency
    context (comment: Onshape's variables/regeneration endpoints are
    inherently idempotent per-workspace when driven by a single worker at a
    time -- see docs/DESIGN.md section 7 on concurrency; passing job_id
    through keeps every log line traceable to the job that triggered it,
    which matters when diagnosing a stuck or double-run job).
    """

    def __init__(
        self,
        settings: Settings | None = None,
        client: httpx.Client | None = None,
        ref: OnshapeRef | None = None,
    ):
        self._settings = settings or get_settings()
        self.dry_run = self._settings.dry_run
        # Default the ref to the env-configured document so existing callers
        # (and the default-model fallback) keep working; per-model callers
        # pass an explicit ref built from their descriptor.
        self._ref = ref or OnshapeRef(
            document_id=self._settings.onshape_document_id,
            workspace_id=self._settings.onshape_workspace_id,
            element_id=self._settings.onshape_element_id,
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

    @property
    def _variables_path(self) -> str:
        r = self._ref
        return (
            f"/api/v6/variables/d/{r.document_id}/w/{r.workspace_id}"
            f"/e/{r.element_id}/variables"
        )

    @retry(
        reraise=True,
        stop=stop_after_attempt(MAX_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=0.5, max=8),
        retry=retry_if_exception(_is_retryable_http_error),
    )
    def _request(self, method: str, path: str, **kwargs: object) -> httpx.Response:
        response = self._client.request(method, path, **kwargs)
        response.raise_for_status()
        return response

    def set_variables(
        self,
        job_id: str,
        values_mm: dict[str, float],
        variable_map: dict[str, str] | None = None,
    ) -> None:
        """Push the 25 measurement variables to the Onshape part studio.

        Converts mm to meters here (and only here). Validates that every
        schema-defined variable name is present in the input before sending,
        since a silent name mismatch is the #1 integration risk called out in
        docs/DESIGN.md section 6.

        `variable_map` (schema-name -> model-variable-name) is applied only to
        the outgoing payload names, right at this boundary, so a model whose
        Onshape variable table uses different identifiers than the 25 schema
        names can still be driven. The input `values_mm` is always keyed by
        the canonical schema names; unmapped names pass through unchanged.
        """
        missing = set(MEASUREMENT_KEYS) - values_mm.keys()
        if missing:
            raise OnshapeError(f"set_variables missing required variables: {sorted(missing)}")

        mapping = variable_map or {}
        values_m = mm_to_m(values_mm)
        payload = {
            "items": [
                {"type": "LENGTH", "name": mapping.get(name, name), "value": value, "unit": "meter"}
                for name, value in values_m.items()
            ]
        }

        if self.dry_run:
            logger.info(
                "[DRY_RUN] job=%s would POST %s with %d variables",
                job_id,
                self._variables_path,
                len(payload["items"]),
            )
            return

        try:
            self._request("POST", self._variables_path, json=payload)
        except httpx.HTTPError as exc:
            raise OnshapeError(f"job={job_id}: failed to set Onshape variables: {exc}") from exc

    def trigger_regeneration(self, job_id: str) -> str:
        """Kick off part studio regeneration after variables change; returns a translation id.

        Onshape's translation/regeneration jobs are asynchronous: this call
        starts one and `poll_regeneration` is used to wait for it to finish.
        """
        if self.dry_run:
            logger.info("[DRY_RUN] job=%s would trigger Onshape regeneration", job_id)
            return "dry-run-translation-id"

        r = self._ref
        path = (
            f"/api/v6/partstudios/d/{r.document_id}/w/{r.workspace_id}"
            f"/e/{r.element_id}/translations"
        )
        try:
            response = self._request("POST", path, json={"formatName": "STL"})
        except httpx.HTTPError as exc:
            raise OnshapeError(f"job={job_id}: failed to trigger regeneration: {exc}") from exc
        return str(response.json().get("id", ""))

    def poll_regeneration(self, job_id: str, translation_id: str) -> bool:
        """Poll a translation until it reports done; returns True once complete.

        A single poll per call by design: the worker loop (jobs/runner.py)
        owns retry/backoff timing via the job queue's `run_after` mechanism
        rather than blocking a worker process in a sleep loop.
        """
        if self.dry_run:
            logger.info(
                "[DRY_RUN] job=%s would poll Onshape translation %s", job_id, translation_id
            )
            return True

        try:
            response = self._request("GET", f"/api/v6/translations/{translation_id}")
        except httpx.HTTPError as exc:
            raise OnshapeError(f"job={job_id}: failed to poll regeneration: {exc}") from exc
        return str(response.json().get("requestState", "")).upper() == "DONE"

    def export_stl(self, job_id: str) -> bytes:
        """Export STL bytes for the current part studio state.

        Onshape regenerates the part studio as part of servicing an export
        request against the current workspace state, so in the common case
        callers can go straight from `set_variables` to `export_stl`;
        `trigger_regeneration`/`poll_regeneration` exist for callers that
        need to wait on a long regeneration explicitly before exporting.
        """
        if self.dry_run:
            logger.info("[DRY_RUN] job=%s would export STL from Onshape", job_id)
            return b"solid dry_run\nendsolid dry_run\n"

        r = self._ref
        path = (
            f"/api/v6/partstudios/d/{r.document_id}/w/{r.workspace_id}"
            f"/e/{r.element_id}/stl"
        )
        try:
            response = self._request("GET", path, params={"mode": "binary"})
        except httpx.HTTPError as exc:
            raise OnshapeError(f"job={job_id}: failed to export STL: {exc}") from exc
        return response.content
