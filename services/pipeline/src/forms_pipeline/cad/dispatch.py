"""CAD dispatch: resolve a job's descriptor and run the right provider.

This is the single entry point the worker uses for CAD generation. It resolves
the per-product descriptor (or falls back to an env-configured default model),
converts the leg measurements to model values per the descriptor's profile
(cad/profile.py, the only place that conversion happens), selects the
provider from the registry, and logs per-job CAD latency
(docs/DESIGN.md section 7: measure per-order latency from day one, since
Onshape regen/export is the pipeline's throughput ceiling).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from forms_pipeline.cad.model import CadModelDescriptor, CadResult
from forms_pipeline.cad.profile import DEFAULT_PROFILE, apply_profile
from forms_pipeline.cad.providers import CadProvider, get_provider
from forms_pipeline.config import Settings
from forms_pipeline.contract import SCHEMA_VERSION

logger = logging.getLogger(__name__)


def default_descriptor(settings: Settings) -> CadModelDescriptor:
    """The fallback CAD model, built from env config.

    Used when a job has no order, or the ordered product carries no cad_model.
    Provider is "onshape" when credentials are configured, else "dry_run", so
    Phase 0 plumbing works end to end without an Onshape account. Carries the
    default crest_spline_v1 profile.
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
        profile=DEFAULT_PROFILE,
    )


def resolve_descriptor(cad_model: dict[str, Any] | None, settings: Settings) -> CadModelDescriptor:
    """Parse a product's stored descriptor, or return the env default when absent."""
    if cad_model is None:
        return default_descriptor(settings)
    return CadModelDescriptor.parse(cad_model)


@dataclass
class CadDispatcher:
    """Resolves the descriptor, picks the provider, generates the CadResult, times it.

    `provider_factory` is a test seam: when set it overrides the registry
    lookup so runner tests can inject a recording/fake provider.
    """

    settings: Settings
    provider_factory: Callable[[str], CadProvider] | None = None

    def generate(
        self, job_id: str, values_mm: dict[str, float], cad_model: dict[str, Any] | None
    ) -> CadResult:
        descriptor = resolve_descriptor(cad_model, self.settings)
        provider = (
            self.provider_factory(descriptor.provider)
            if self.provider_factory is not None
            else get_provider(descriptor.provider, self.settings)
        )

        # Leg measurements in, model values out (mm both sides). Raises
        # ProfileError (non-retriable) before any provider call.
        values_model = apply_profile(values_mm, descriptor.profile)

        start = time.monotonic()
        result = provider.generate_stl(job_id, values_model, descriptor)
        elapsed = time.monotonic() - start
        logger.info(
            "cad generation complete job=%s provider=%s elapsed_seconds=%.3f",
            job_id,
            descriptor.provider,
            elapsed,
        )
        return CadResult(
            result.stl_bytes,
            {
                **result.artifacts,
                "profile_kind": descriptor.profile.kind,
                "model_values_mm": values_model,
            },
        )
