"""The per-product CAD model descriptor.

docs/DESIGN.md section 7 calls for CAD generation to sit behind a single
provider interface so the product can carry many parametric models (one per
guard design) and swap CAD backends (Onshape now, code-CAD like CadQuery
later) without a rewrite. This module defines the descriptor that names which
model/provider a product uses. It is stored as a JSON document in the
`cad_model` column of `public.products` (see
supabase/migrations/0006_cad_models.sql) and parsed/validated here.

Descriptor shape:

    {
      "provider": "onshape",            # registry key; also "dry_run"; future "cadquery"
      "schema_version": "1.0.0",        # measurement schema version the model expects
      "ref": {"document_id": "...", "workspace_id": "...", "element_id": "..."},
      "variable_map": null               # or {"<schema-name>": "<model-variable-name>"}
    }

`ref` is provider-specific and validated inside the owning provider, not here.
Any descriptor problem (bad shape, a variable_map key outside the 25 schema
names, or a map that cannot resolve all 25 variables to distinct model names)
is a NON-RETRIABLE failure: retrying the same descriptor can never succeed, so
the runner fails the job (never the worker).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from zells_pipeline.contract import MEASUREMENT_KEYS


class DescriptorError(ValueError):
    """Non-retriable failure: the CAD model descriptor is malformed.

    Covers an unparseable descriptor document, a variable_map that references
    a name outside the 25-variable schema, a map that collapses two schema
    names onto one model variable, and (raised by the provider) a ref missing
    provider-required identifiers. None of these succeed on retry.
    """


class CadModelDescriptor(BaseModel):
    """Validated CAD model descriptor for one product.

    Immutable and closed to unknown top-level keys so a typo in a stored
    descriptor surfaces as a clear failure rather than being silently ignored.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str = Field(min_length=1)
    schema_version: str = Field(min_length=1)
    # Provider-specific; its concrete shape is validated by the provider that
    # consumes it, not here, so new backends can define their own ref fields.
    ref: dict[str, Any] = Field(default_factory=dict)
    # schema-name -> model-variable-name. None (or omitted) means identity for
    # all 25 names.
    variable_map: dict[str, str] | None = None

    @model_validator(mode="after")
    def _validate_variable_map(self) -> CadModelDescriptor:
        mapping = self.variable_map or {}

        unknown = set(mapping) - set(MEASUREMENT_KEYS)
        if unknown:
            raise ValueError(
                "variable_map keys must be a subset of the 25 schema names; "
                f"unknown key(s): {sorted(unknown)}"
            )

        # Every schema name must resolve (identity for unmapped) to a distinct
        # model variable name; two names collapsing onto one would silently
        # drop a variable from the payload.
        resolved = [mapping.get(name, name) for name in MEASUREMENT_KEYS]
        if len(set(resolved)) != len(MEASUREMENT_KEYS):
            raise ValueError(
                "variable_map does not resolve all 25 variables to distinct model "
                "variable names (two schema names map to the same target)."
            )
        return self

    @classmethod
    def parse(cls, data: dict[str, Any]) -> CadModelDescriptor:
        """Parse a stored descriptor dict, raising DescriptorError on any problem."""
        try:
            return cls.model_validate(data)
        except ValidationError as exc:
            raise DescriptorError(f"invalid CAD model descriptor: {exc}") from exc
