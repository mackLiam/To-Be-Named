-- 0017_client_write_lockdown.sql
-- Closes three client write paths found in the accounts security review
-- (after 0012 / 0013). Each was harmless to other users but let a client
-- write state that only the server should own.
--
-- 1. orders: no client inserts at all. Checkout creates orders with the
--    service role (0013, apps/web /api/checkout), which also enforces the
--    per-user pending cap and the account-deletion refusal. The 0012 client
--    policy let a member insert rows carrying stripe_checkout_session_id,
--    paid_at or refunded_at (0013 columns the policy predates) and bypass
--    the pending cap with one multi-row insert. RLS stays enabled with only
--    "orders: select own", so client inserts are denied by default.
-- 2. scans.deleted_at: clients may no longer set it directly. Deletion goes
--    through request_scan_deletion / request_account_deletion (definer, so
--    current_user is the owner and this guard does not apply), which check
--    orders and dead-letter queued jobs. A direct update skipped both.
-- 3. scans.mesh_path: clients may only write `<storage_user_id>/<segments>`
--    with plain filename characters and no dot segments or percent escapes.
--    The worker re-checks (runner.owned_mesh_path), but the storage URL is
--    built from this string, so the boundary should not accept traversal.

-- ---------------------------------------------------------------------------
-- 1. orders
-- ---------------------------------------------------------------------------
drop policy "orders: members insert pending own" on public.orders;

-- 0012 added this only for the client insert policy above.
drop function public.account_deletion_pending();

-- ---------------------------------------------------------------------------
-- 2. scans client guard (0013), plus the deleted_at freeze. Behavior is
-- otherwise unchanged: invoker, gated on the client roles, status coerced
-- except capturing -> uploaded, failed_step and mesh_deleted_at frozen.
-- ---------------------------------------------------------------------------
create or replace function public.scans_guard_client_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('capturing', 'uploaded') then
      raise exception 'clients may only create scans as capturing or uploaded (got %)', new.status
        using errcode = 'check_violation';
    end if;
    new.failed_step := null;
    new.mesh_deleted_at := null;
    new.deleted_at := null;
  else
    -- Coerce rather than raise: the app's upload retry re-upserts the row
    -- with status 'uploaded' after the measure job has moved it on, and that
    -- retry must keep succeeding.
    if not (old.status = 'capturing' and new.status = 'uploaded') then
      new.status := old.status;
    end if;
    new.failed_step := old.failed_step;
    new.mesh_deleted_at := old.mesh_deleted_at;
    new.deleted_at := old.deleted_at;
  end if;
  return new;
end;
$$;

revoke execute on function public.scans_guard_client_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. mesh_path format on client writes (RLS only: workers write with the
-- service role and are validated by owned_mesh_path).
-- ---------------------------------------------------------------------------
alter policy "scans: insert own" on public.scans
  with check (
    user_id = auth.uid()
    and (mesh_path is null or (
      split_part(mesh_path, '/', 1) = storage_user_id::text
      and mesh_path ~ '^[0-9a-f-]{36}(/[A-Za-z0-9_.-]+)+$'
      and mesh_path !~ '(^|/)\.{1,2}(/|$)'))
  );

alter policy "scans: update own" on public.scans
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (mesh_path is null or (
      split_part(mesh_path, '/', 1) = storage_user_id::text
      and mesh_path ~ '^[0-9a-f-]{36}(/[A-Za-z0-9_.-]+)+$'
      and mesh_path !~ '(^|/)\.{1,2}(/|$)'))
  );
