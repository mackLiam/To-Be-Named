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
      "schema_version": "1.1.0",        # measurement schema version the model expects
      "ref": {"document_id": "...", "workspace_id": "...", "element_id": "..."},
      "variable_map": null,              # or {"<schema-name>": "<model-variable-name>"}
      "variable_kind": "part_studio_features",  # optional; or "variable_studio"
      "profile": {"kind": "crest_spline_v1",    # required; or {"kind": "identity"}
                  "wrap": {"inner_shin": 0.35, "inner_calf": 0.6, "outer": 0.7}}
    }

profile (required) names the conversion from LEG measurements (what the
measurement schema stores) to the model's variable values, which are a
different quantity under the same names (docs/DESIGN.md 12.2). The conversion
itself lives in cad/profile.py; only its parameters are validated here. Rules,
mirrored in packages/shared: kind is "identity" (no other keys) or
"crest_spline_v1" with a wrap object of exactly inner_shin, inner_calf and
outer, each a finite non-bool number with 0 < inner_shin < inner_calf < 1 and
0 < outer < 1.

variable_kind (Onshape only) says where the model keeps its variables:
Part Studio Variable features in a template copied per job (default), or a
Variable Studio written in place.

`ref` is provider-specific and validated inside the owning provider, not here.
Any descriptor problem (bad shape, a variable_map key outside the 25 schema
names, or a map that cannot resolve all 25 variables to distinct model names)
is a NON-RETRIABLE failure: retrying the same descriptor can never succeed, so
the runner fails the job (never the worker).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import (
    AllowInfNan,
    BaseModel,
    ConfigDict,
    Field,
    Strict,
    ValidationError,
    model_validator,
)

from forms_pipeline.contract import MEASUREMENT_KEYS


class DescriptorError(ValueError):
    """Non-retriable failure: the CAD model descriptor is malformed.

    Covers an unparseable descriptor document, a variable_map that references
    a name outside the 25-variable schema, a map that collapses two schema
    names onto one model variable, a missing or invalid profile, and (raised
    by the provider) a ref missing provider-required identifiers. None of
    these succeed on retry.
    """


# Strict rejects bools and numeric strings; AllowInfNan(False) rejects nan/inf.
WrapFraction = Annotated[float, Strict(), AllowInfNan(False)]


class Wrap(BaseModel):
    """How far round each side of the crest the guard reaches, as a fraction of the half-width."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    inner_shin: WrapFraction
    inner_calf: WrapFraction
    outer: WrapFraction

    @model_validator(mode="after")
    def _validate_order(self) -> Wrap:
        # The model's spline needs inner shin strictly inside inner calf, and
        # every point strictly inside the section (a fraction of 1 or more
        # puts the point at or past the leg's widest extent).
        if not 0 < self.inner_shin < self.inner_calf < 1:
            raise ValueError("wrap must satisfy 0 < inner_shin < inner_calf < 1")
        if not 0 < self.outer < 1:
            raise ValueError("wrap must satisfy 0 < outer < 1")
        return self


class IdentityProfile(BaseModel):
    """Leg values are sent to the model unchanged."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["identity"]


class CrestSplineV1Profile(BaseModel):
    """Leg values become crest-relative spline points (cad/profile.py)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["crest_spline_v1"]
    wrap: Wrap


Profile = Annotated[IdentityProfile | CrestSplineV1Profile, Field(discriminator="kind")]


@dataclass(frozen=True)
class CadResult:
    """A provider's output: STL bytes plus provider-specific job artifacts."""

    stl_bytes: bytes
    artifacts: dict[str, Any] = field(default_factory=dict)


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
    variable_kind: Literal["variable_studio", "part_studio_features"] = "part_studio_features"
    # Required, no default: a stored descriptor that predates profiles must
    # fail loudly rather than silently send leg values to the model.
    profile: Profile

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
