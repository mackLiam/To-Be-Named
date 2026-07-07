-- 0006_cad_models.sql
-- Attach a provider-agnostic CAD model descriptor to each product.
--
-- docs/DESIGN.md section 7: CAD generation sits behind a single provider
-- interface so the product can carry many parametric models (one per guard
-- design) and swap CAD backends (Onshape now, code-CAD like CadQuery later)
-- without a rewrite. Previously the worker was hardwired to one Onshape
-- document from env config; the descriptor moves that choice into data,
-- per product.
--
-- Descriptor shape (validated in full by the worker,
-- zells_pipeline/cad/model.py):
--   {
--     "provider": "onshape",            -- registry key; also "dry_run"; future "cadquery"
--     "schema_version": "1.0.0",        -- measurement schema version the model expects
--     "ref": { "document_id": "...", "workspace_id": "...", "element_id": "..." },
--     "variable_map": null               -- or { "<schema-name>": "<model-variable-name>" }
--   }
-- Null cad_model means "use the worker's env-configured default model".

alter table public.products
  add column cad_model jsonb;

comment on column public.products.cad_model is
  'Provider-agnostic CAD model descriptor { provider, schema_version, ref, variable_map }. Null falls back to the worker''s env-configured default model. Full validation lives in zells_pipeline/cad/model.py; this column only guarantees a provider key is present.';

-- Minimal, deliberately loose shape guard: a present descriptor must at least
-- name a provider. Not over-constrained here (ref is provider-specific,
-- variable_map is optional) because the worker does the real validation and
-- fails a job non-retriably on a bad descriptor.
alter table public.products
  add constraint products_cad_model_has_provider
  check (cad_model is null or (cad_model ? 'provider'));

-- RLS is unchanged: products remain publicly readable (0002_rls.sql
-- "products: select all"), writes stay service-role only. The descriptor
-- carries no secrets (Onshape credentials live only in the worker's env), so
-- exposing it to the read-only catalog policy is safe.
