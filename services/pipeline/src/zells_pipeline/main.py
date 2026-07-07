"""Process entry point: runs the FastAPI health server and the worker loop together.

The worker loop is blocking (simple `for job in claimed: ...` plus a sleep
between empty polls), so it runs on a background thread while uvicorn owns
the main thread for the HTTP server. Both share the same process so a
single container/Fly machine hosts both the health check and the queue
consumer for Phase 0; splitting them into separate processes is a
straightforward later change if the worker needs to scale independently of
the health endpoint.
"""

from __future__ import annotations

import logging
import socket
import threading

import uvicorn

from zells_pipeline.api import app
from zells_pipeline.cad.dispatch import CadDispatcher
from zells_pipeline.config import get_settings
from zells_pipeline.jobs.runner import (
    JobContext,
    PostgresJobStore,
    SupabaseStorageClient,
    run_forever,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _worker_id() -> str:
    return f"{socket.gethostname()}-{threading.get_ident()}"


def start_worker_thread() -> threading.Thread:
    settings = get_settings()
    ctx = JobContext(
        store=PostgresJobStore(settings),
        storage=SupabaseStorageClient(settings),
        cad=CadDispatcher(settings=settings),
    )
    thread = threading.Thread(
        target=run_forever, args=(_worker_id(), ctx), daemon=True, name="pipeline-worker"
    )
    thread.start()
    logger.info("worker thread started (dry_run=%s)", settings.dry_run)
    return thread


def main() -> None:
    start_worker_thread()
    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104 - intentional: container-internal bind


if __name__ == "__main__":
    main()
