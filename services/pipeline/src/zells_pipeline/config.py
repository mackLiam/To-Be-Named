"""Worker configuration.

All secrets (Supabase service role key, Onshape access/secret keys, database
URL) come from the environment only. They must never be hardcoded, committed,
or logged: `Settings.__repr__` is overridden below so an accidental `print`,
log line, or exception traceback that includes the settings object does not
leak credential values.

See docs/DESIGN.md section 9 (Security & Privacy) for the retention and
least-privilege posture this configuration supports.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root is five levels up from this file:
# services/pipeline/src/zells_pipeline/config.py -> zells_pipeline -> src ->
# pipeline -> services -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_SCHEMA_PATH = _REPO_ROOT / "packages" / "shared" / "schema" / "measurements.schema.json"

# Fields that hold secret material. Kept in one place so __repr__ /
# __str__ overrides below and any future redaction logic stay in sync.
_SECRET_FIELDS = frozenset(
    {
        "database_url",
        "supabase_service_role_key",
        "onshape_access_key",
        "onshape_secret_key",
    }
)


class Settings(BaseSettings):
    """Environment-driven configuration for the pipeline worker.

    Values load from process environment variables (case-insensitive) and,
    for local development, from a `.env` file at the repo root. In
    production (Docker/Fly.io/Railway) only real environment variables are
    used; no .env file is shipped in the image.
    """

    model_config = SettingsConfigDict(
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # -- Database / queue -------------------------------------------------
    database_url: SecretStr = Field(
        default=SecretStr(""),
        description="Postgres connection string (Supabase) used for the pipeline_jobs queue.",
    )

    # -- Supabase -----------------------------------------------------------
    supabase_url: str = Field(default="", description="Supabase project URL.")
    supabase_service_role_key: SecretStr = Field(
        default=SecretStr(""),
        description="Service role key. Server-side only, never sent to any client.",
    )

    # -- Onshape --------------------------------------------------------------
    onshape_access_key: SecretStr = Field(default=SecretStr(""))
    onshape_secret_key: SecretStr = Field(default=SecretStr(""))
    onshape_base_url: str = Field(default="https://cad.onshape.com")
    onshape_document_id: str = Field(default="")
    onshape_workspace_id: str = Field(default="")
    onshape_element_id: str = Field(default="")

    # -- Worker behavior ------------------------------------------------------
    pipeline_env: str = Field(default="development")
    # Accepts PIPELINE_MAX_MESH_MB (the name already used in the repo-root
    # .env.example, out of scope for this change) as well as the
    # field-name-derived MAX_MESH_MB.
    max_mesh_mb: int = Field(
        default=100,
        gt=0,
        description="Untrusted-upload size cap in MB.",
        validation_alias=AliasChoices("PIPELINE_MAX_MESH_MB", "MAX_MESH_MB", "max_mesh_mb"),
    )
    max_vertices: int = Field(
        default=2_000_000, gt=0, description="Untrusted-mesh vertex count cap."
    )
    schema_path: Path = Field(
        default=_DEFAULT_SCHEMA_PATH,
        description=(
            "Path to the frozen 25-variable measurement JSON Schema. Defaults to the "
            "in-repo location; overridable via SCHEMA_PATH so the Docker image (which "
            "copies only the schema file, not the whole monorepo) can point at its "
            "own copy."
        ),
    )

    @property
    def max_mesh_bytes(self) -> int:
        return self.max_mesh_mb * 1024 * 1024

    @property
    def dry_run(self) -> bool:
        """True when Onshape credentials are not configured.

        Lets Phase 0 plumbing (queue, extraction, state machine) be exercised
        end to end without an Onshape account: the Onshape client logs
        intended calls and returns canned results instead of hitting the
        network.
        """
        return not (
            self.onshape_access_key.get_secret_value()
            and self.onshape_secret_key.get_secret_value()
        )

    def __repr__(self) -> str:  # pragma: no cover - trivial
        redacted = ", ".join(
            f"{name}=<redacted>" if name in _SECRET_FIELDS else f"{name}={getattr(self, name)!r}"
            for name in self.model_fields
        )
        return f"Settings({redacted})"

    __str__ = __repr__


def get_settings() -> Settings:
    """Construct Settings fresh from the current environment.

    Not cached: tests and the worker both want a clean read of the
    environment at call time (e.g. after monkeypatching env vars).
    """
    return Settings()
