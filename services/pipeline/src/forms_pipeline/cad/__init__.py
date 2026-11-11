"""Provider-agnostic CAD generation for the pipeline (docs/DESIGN.md section 7)."""

from __future__ import annotations

from forms_pipeline.cad.dispatch import (
    CadDispatcher,
    default_descriptor,
    resolve_descriptor,
)
from forms_pipeline.cad.model import CadModelDescriptor, CadResult, DescriptorError
from forms_pipeline.cad.profile import DEFAULT_PROFILE, ProfileError, apply_profile
from forms_pipeline.cad.providers import (
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
    "CadResult",
    "DEFAULT_PROFILE",
    "DescriptorError",
    "DryRunProvider",
    "OnshapeProvider",
    "ProfileError",
    "ProviderNotFoundError",
    "apply_profile",
    "default_descriptor",
    "get_provider",
    "resolve_descriptor",
]
