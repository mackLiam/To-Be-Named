-- ---------------------------------------------------------------------------
-- 0005: lock down queue helper function grants.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- Supabase's PostgREST exposes public-schema functions to anon/authenticated
-- clients as RPC endpoints. The queue helpers in 0001 predate the explicit
-- revoke convention started in 0004 (get_meshes_pending_deletion), so any
-- client could invoke them via RPC. They run with invoker rights, so
-- deny-by-default RLS on pipeline_jobs (0002) still blocks the underlying
-- writes, but the functions should not be callable by clients at all:
-- defense in depth, no error-message probing, and no reliance on RLS staying
-- exactly as strict as it is today. Only the service-role worker calls them.
--
-- Convention from here on: every new public-schema function ships with an
-- explicit revoke in the same migration unless it is deliberately part of
-- the client API.
--
-- Verified by review, not by an automated harness (repo convention: the
-- test suite exercises the Python side against fakes; SQL migrations are
-- review-only until a hosted test project exists, ROADMAP.md week 5).
-- ---------------------------------------------------------------------------

revoke execute on function public.claim_pipeline_job(text, integer) from public;
revoke execute on function public.advance_pipeline_job(uuid, text, jsonb) from public;
revoke execute on function public.complete_pipeline_job(uuid, jsonb) from public;
revoke execute on function public.fail_pipeline_job(uuid, jsonb, boolean) from public;

-- service_role retains access: Supabase grants it bypassrls and it is a
-- member of no revoked grantee here; explicit re-grant keeps intent obvious
-- even if PUBLIC defaults change.
grant execute on function public.claim_pipeline_job(text, integer) to service_role;
grant execute on function public.advance_pipeline_job(uuid, text, jsonb) to service_role;
grant execute on function public.complete_pipeline_job(uuid, jsonb) to service_role;
grant execute on function public.fail_pipeline_job(uuid, jsonb, boolean) to service_role;
