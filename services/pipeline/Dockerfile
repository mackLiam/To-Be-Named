# Build context MUST be the monorepo root, not services/pipeline, because
# this image needs packages/shared/schema alongside the service source, e.g.:
#
#   docker build -f services/pipeline/Dockerfile -t zells-pipeline .
#
# (from the repo root).

FROM python:3.12-slim

# Untrusted-input parsing (trimesh) and Postgres client libs need these at
# runtime; kept minimal and slim-compatible.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system zells && useradd --system --gid zells --home /app zells

WORKDIR /app

COPY services/pipeline/pyproject.toml services/pipeline/README.md ./
COPY services/pipeline/src ./src
# The measurement schema is the single source of truth for the 25-variable
# contract (docs/DESIGN.md gotcha #2); the image needs its own copy since
# the build context for this image is the pipeline service plus this one
# shared file, not the whole monorepo checkout.
COPY packages/shared/schema/measurements.schema.json /app/schema/measurements.schema.json
ENV SCHEMA_PATH=/app/schema/measurements.schema.json

RUN pip install --no-cache-dir .

USER zells

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/healthz || exit 1

CMD ["python", "-m", "zells_pipeline.main"]
