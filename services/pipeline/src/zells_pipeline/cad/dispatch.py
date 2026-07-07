"""CAD dispatch: resolve a job's descriptor and run the right provider.

This is the single entry point the worker uses for CAD generation. It resolves
the per-product descriptor (or falls back to an env-configured default model),
selects the provider from the registry, and logs per-job CAD latency
(docs/DESIGN.md section 7: measure per-order latency from day one, since
Onshape regen/export is the pipeline's throughput ceiling).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from zells_pipeline.cad.model import CadModelDescriptor
from zells_pipeline.cad.providers import CadProvider, get_provider
from zells_pipeline.config import Settings
from zells_pipeline.contract import SCHEMA_VERSION

logger = logging.getLogger(__name__)


def default_descriptor(settings: Settings) -> CadModelDescriptor:
    """The fallback CAD model, built from env config.

    Used when a job has no order, or the ordered product carries no cad_model.
    Provider is "onshape" when credentials are configured, else "dry_run", so
    Phase 0 plumbing works end to end without an Onshape account.
    """
    provider = "dry_run" if settings.dry_run else "onshape"
    return CadModelDescriptor(
        provider=provider,
        schema_version=SCHEMA_VERSION,
        ref={
            "document_id": settings.onshape_document_id,
            "workspace_id": settings.onshape_workspace_id,
            "element_id": settings.onshape_element_id,
        },
        variable_map=None,
    )


def resolve_descriptor(
    cad_model: dict[str, Any] | None, settings: Settings
) -> CadModelDescriptor:
    """Parse a product's stored descriptor, or return the env default when absent."""
    if cad_model is None:
        return default_descriptor(settings)
    return CadModelDescriptor.parse(cad_model)


@dataclass
class CadDispatcher:
    """Resolves the descriptor, picks the provider, generates STL, times it.

    `provider_factory` is a test seam: when set it overrides the registry
    lookup so runner tests can inject a recording/fake provider.
    """

    settings: Settings
    provider_factory: Callable[[str], CadProvider] | None = None

    def run(
        self, job_id: str, values_mm: dict[str, float], cad_model: dict[str, Any] | None
    ) -> bytes:
        descriptor = resolve_descriptor(cad_model, self.settings)
        provider = (
            self.provider_factory(descriptor.provider)
            if self.provider_factory is not None
            else get_provider(descriptor.provider, self.settings)
        )

        start = time.monotonic()
        stl_bytes = provider.generate_stl(job_id, values_mm, descriptor)
        elapsed = time.monotonic() - start
        logger.info(
            "cad generation complete job=%s provider=%s elapsed_seconds=%.3f",
            job_id,
            descriptor.provider,
            elapsed,
        )
        return stl_bytes
