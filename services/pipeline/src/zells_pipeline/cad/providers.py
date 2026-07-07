"""CAD provider interface, implementations, and registry.

docs/DESIGN.md section 7: the architecture isolates CAD generation behind a
single interface so porting from Onshape to code-CAD (CadQuery/build123d) is a
swap, not a rewrite. A provider takes the 25 measurement values (always in
millimeters, the pipeline's canonical unit) plus a descriptor, and returns STL
bytes. The millimeters -> native-unit conversion happens exactly once, inside
the provider (docs/DESIGN.md gotcha #1); no other layer converts units.

Providers:
- OnshapeProvider: drives the existing Onshape REST client against the ref in
  the descriptor (not the env default), applying the descriptor's variable_map
  and preserving the DRY_RUN fallback when credentials are absent.
- DryRunProvider: returns a canned STL and logs; for demo products and
  plumbing tests with no CAD backend at all.

Unknown provider names raise ProviderNotFoundError, which the runner treats as
a non-retriable job failure.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Protocol, runtime_checkable

import httpx

from zells_pipeline.cad.model import CadModelDescriptor, DescriptorError
from zells_pipeline.config import Settings, get_settings
from zells_pipeline.onshape.client import OnshapeClient, OnshapeRef

logger = logging.getLogger(__name__)

# Canned STL used by the dry-run provider. Kept identical to the Onshape
# client's dry-run output so downstream plumbing sees the same bytes.
DRY_RUN_STL = b"solid dry_run\nendsolid dry_run\n"


class ProviderNotFoundError(ValueError):
    """Non-retriable: the descriptor names a provider with no registered implementation."""


@runtime_checkable
class CadProvider(Protocol):
    """Generates STL bytes for one job from the 25 measurements plus a descriptor."""

    name: str

    def generate_stl(
        self, job_id: str, values_mm: dict[str, float], model: CadModelDescriptor
    ) -> bytes: ...


def _onshape_ref_from_descriptor(model: CadModelDescriptor) -> OnshapeRef:
    """Build the Onshape document ref from the descriptor, or fail non-retriably."""
    ref = model.ref or {}
    required = ("document_id", "workspace_id", "element_id")
    missing = [key for key in required if not ref.get(key)]
    if missing:
        raise DescriptorError(
            f"onshape descriptor ref is missing required id(s): {sorted(missing)}"
        )
    return OnshapeRef(
        document_id=str(ref["document_id"]),
        workspace_id=str(ref["workspace_id"]),
        element_id=str(ref["element_id"]),
    )


class OnshapeProvider:
    """CAD provider backed by the Onshape REST API.

    Uses the descriptor's ref (per-model document/workspace/element) rather
    than the env-configured default, applies the descriptor's variable_map at
    the Onshape boundary, and inherits the client's DRY_RUN behavior when no
    credentials are configured. Retry semantics live in OnshapeClient and are
    preserved unchanged.
    """

    name = "onshape"

    def __init__(
        self, settings: Settings | None = None, http_client: httpx.Client | None = None
    ):
        self._settings = settings or get_settings()
        # Optional injected httpx client for tests; when None the OnshapeClient
        # builds (and this provider closes) its own per-call client.
        self._http_client = http_client

    def generate_stl(
        self, job_id: str, values_mm: dict[str, float], model: CadModelDescriptor
    ) -> bytes:
        ref = _onshape_ref_from_descriptor(model)
        client = OnshapeClient(settings=self._settings, client=self._http_client, ref=ref)
        try:
            client.set_variables(job_id, values_mm, variable_map=model.variable_map)
            client.trigger_regeneration(job_id)
            return client.export_stl(job_id)
        finally:
            if self._http_client is None:
                client.close()


class DryRunProvider:
    """CAD provider that returns a canned STL without touching any backend."""

    name = "dry_run"

    def generate_stl(
        self, job_id: str, values_mm: dict[str, float], model: CadModelDescriptor
    ) -> bytes:
        logger.info(
            "[DRY_RUN] job=%s dry-run CAD provider returning canned STL (%d variables)",
            job_id,
            len(values_mm),
        )
        return DRY_RUN_STL


# Provider registry. Factories take Settings so credential/base-url config
# reaches the provider without threading it through get_provider's callers.
_REGISTRY: dict[str, Callable[[Settings], CadProvider]] = {
    "onshape": lambda settings: OnshapeProvider(settings),
    "dry_run": lambda settings: DryRunProvider(),
}


def get_provider(name: str, settings: Settings | None = None) -> CadProvider:
    """Return the registered provider for `name`, or raise ProviderNotFoundError."""
    try:
        factory = _REGISTRY[name]
    except KeyError:
        raise ProviderNotFoundError(
            f"unknown CAD provider {name!r}; registered providers: {sorted(_REGISTRY)}"
        ) from None
    return factory(settings or get_settings())
