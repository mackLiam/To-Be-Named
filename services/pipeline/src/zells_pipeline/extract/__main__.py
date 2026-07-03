"""`python -m zells_pipeline.extract` entry point. See `cli.main` for the implementation."""

from __future__ import annotations

import sys

from zells_pipeline.extract.cli import main

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
