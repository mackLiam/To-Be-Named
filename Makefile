SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT          := $(CURDIR)
PIPELINE_DIR  := services/pipeline
VENV          := $(ROOT)/$(PIPELINE_DIR)/.venv
VENV_BIN      := $(VENV)/bin
PYTHON        := python3.12

.DEFAULT_GOAL := help

.PHONY: help bootstrap dev dev-app dev-web dev-pipeline \
        test test-js test-py lint format typecheck db-reset clean \
        check-node check-pnpm check-python check-venv

help: ## Show this help
	@echo "Zells - make targets:"
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

check-node: ## (internal) verify node is available (needed for corepack/pnpm)
	@command -v node >/dev/null 2>&1 || { \
		echo "error: node not found. Install Node $$(cat .nvmrc) via nvm/fnm/asdf first."; \
		exit 1; \
	}

check-pnpm: ## (internal) verify pnpm is available
	@command -v pnpm >/dev/null 2>&1 || { \
		echo "error: pnpm not found. Run 'make bootstrap' first (it runs 'corepack enable' for you)."; \
		exit 1; \
	}

check-python: ## (internal) verify python3.12 is available
	@command -v $(PYTHON) >/dev/null 2>&1 || { \
		echo "error: $(PYTHON) not found. Install Python $$(cat .python-version), e.g. via pyenv or brew."; \
		exit 1; \
	}

check-venv: check-python ## (internal) verify the pipeline venv exists
	@test -x "$(VENV_BIN)/python" || { \
		echo "error: $(VENV) not found. Run 'make bootstrap' first."; \
		exit 1; \
	}

bootstrap: check-node check-python ## Install JS + Python deps, create pipeline venv, seed .env
	corepack enable
	pnpm install
	$(PYTHON) -m venv $(VENV)
	$(VENV_BIN)/pip install --upgrade pip
	$(VENV_BIN)/pip install -e "$(PIPELINE_DIR)[dev]"
	@if [ -f .env ]; then \
		echo ".env already exists - leaving it untouched"; \
	else \
		cp .env.example .env; \
		echo "created .env from .env.example - fill in real values before running anything"; \
	fi
	@echo "bootstrap complete"

dev: ## Print how to start each dev server (run each in its own terminal)
	@echo "Run one of these in its own terminal:"
	@echo "  make dev-app        # Expo app (apps/app), pnpm --filter @zells/app dev"
	@echo "  make dev-web        # Next.js site (apps/web), pnpm --filter @zells/web dev"
	@echo "  make dev-pipeline   # Python pipeline worker (services/pipeline), uvicorn --reload"

dev-app: check-pnpm ## Run the Expo app dev server
	pnpm --filter @zells/app dev

dev-web: check-pnpm ## Run the Next.js web dev server
	pnpm --filter @zells/web dev

dev-pipeline: check-venv ## Run the pipeline worker (FastAPI, autoreload)
	# Assumes the worker exposes a FastAPI app at zells_pipeline.api:app.
	# If that module doesn't exist yet, fall back to:
	#   $(VENV_BIN)/python -m zells_pipeline
	$(VENV_BIN)/uvicorn zells_pipeline.api:app --reload --app-dir $(PIPELINE_DIR)/src

test: test-js test-py ## Run all tests (JS + Python)

test-js: check-pnpm ## Run JS/TS tests via turbo
	pnpm turbo run test

test-py: check-venv ## Run pipeline tests via pytest
	cd $(PIPELINE_DIR) && $(VENV_BIN)/pytest

lint: check-pnpm check-venv ## Lint everything: turbo lint, prettier check, ruff check
	pnpm turbo run lint
	pnpm format:check
	cd $(PIPELINE_DIR) && $(VENV_BIN)/ruff check .

format: check-pnpm check-venv ## Format everything: prettier write, ruff format
	pnpm format
	cd $(PIPELINE_DIR) && $(VENV_BIN)/ruff format .

typecheck: check-pnpm ## Typecheck all JS/TS packages via turbo
	pnpm turbo run typecheck

db-reset: ## Reset the local Supabase stack (requires Supabase CLI + Docker running)
	@command -v supabase >/dev/null 2>&1 || { \
		echo "error: supabase CLI not found. Install: https://supabase.com/docs/guides/cli"; \
		exit 1; \
	}
	supabase db reset

clean: ## Remove node_modules, build outputs, the pipeline venv, and caches
	@echo "Removing:"
	@echo "  node_modules (root, apps/app, apps/web, packages/shared)"
	@echo "  .turbo caches (root and per-package)"
	@echo "  build outputs (packages/shared/dist, apps/app/dist, apps/web/.next)"
	@echo "  $(PIPELINE_DIR)/.venv"
	@echo "  $(PIPELINE_DIR) caches (__pycache__, .pytest_cache, .ruff_cache)"
	rm -rf node_modules
	rm -rf apps/app/node_modules
	rm -rf apps/web/node_modules
	rm -rf packages/shared/node_modules
	rm -rf .turbo
	rm -rf apps/app/.turbo
	rm -rf apps/web/.turbo
	rm -rf packages/shared/.turbo
	rm -rf $(PIPELINE_DIR)/.turbo
	rm -rf packages/shared/dist
	rm -rf apps/app/dist
	rm -rf apps/web/.next
	rm -rf $(VENV)
	rm -rf $(PIPELINE_DIR)/.pytest_cache
	rm -rf $(PIPELINE_DIR)/.ruff_cache
	find $(PIPELINE_DIR) -type d -name '__pycache__' -exec rm -rf {} +
