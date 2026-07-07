"""Provider-agnostic CAD generation for the pipeline (docs/DESIGN.md section 7)."""

from __future__ import annotations

from zells_pipeline.cad.dispatch import (
    CadDispatcher,
    default_descriptor,
    resolve_descriptor,
)
from zells_pipeline.cad.model import CadModelDescriptor, DescriptorError
from zells_pipeline.cad.providers import (
    CadProvider,
    DryRunProvider,
    OnshapeProvider,
    ProviderNotFoundError,
    get_provider,
)

__all__ = [
    "CadDispatcher",
    "CadModelDescriptor",
    "CadProvider",
    "DescriptorError",
    "DryRunProvider",
    "OnshapeProvider",
    "ProviderNotFoundError",
    "default_descriptor",
    "get_provider",
    "resolve_descriptor",
]
