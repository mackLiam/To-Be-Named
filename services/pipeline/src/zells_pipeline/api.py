"""FastAPI app exposing only a health check.

No other public HTTP surface: the worker's real job is the queue loop in
`jobs.runner`, driven by `main.py`. `/healthz` exists for container platform
health checks (Fly.io/Railway) and to make dry-run status visible without
grepping logs.
"""

from __future__ import annotations

from fastapi import FastAPI

from zells_pipeline import __version__
from zells_pipeline.config import get_settings
from zells_pipeline.contract import SCHEMA_VERSION

app = FastAPI(title="zells-pipeline", version=__version__)


@app.get("/healthz")
def healthz() -> dict[str, str | bool]:
    settings = get_settings()
    return {
        "status": "ok",
        "version": __version__,
        "schema_version": SCHEMA_VERSION,
        "dry_run": settings.dry_run,
    }
