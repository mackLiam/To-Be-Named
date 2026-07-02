-- 0002_rls.sql
-- Row Level Security for every table in the public schema.
--
-- Philosophy (DESIGN.md section 9): scans are sensitive personal data
-- (biometric-adjacent, likely minors). Default posture is deny; every grant
-- of access is an explicit, commented policy. The pipeline worker and the
-- admin panel connect with the Supabase service_role key, which bypasses
-- RLS entirely and always runs server-side (never shipped to a client) -
-- so "service role only" below means "no policy needed here at all."
--
-- This migration assumes the standard Supabase roles (anon, authenticated,
-- service_role) and their default table grants already exist, as they do on
-- every Supabase project by platform default. RLS policies are the actual
-- access boundary; grants are not re-declared here.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles: select own"
on public.profiles for select
to authenticated
using (user_id = auth.uid());

create policy "profiles: insert own"
on public.profiles for insert
to authenticated
with check (user_id = auth.uid());

create policy "profiles: update own"
on public.profiles for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- No delete policy: profile rows are removed via the auth.users cascade
-- (account deletion), not by a direct user-initiated row delete.

-- ---------------------------------------------------------------------------
-- scans
-- ---------------------------------------------------------------------------
alter table public.scans enable row level security;

create policy "scans: select own"
on public.scans for select
to authenticated
using (user_id = auth.uid());

create policy "scans: insert own"
on public.scans for insert
to authenticated
with check (user_id = auth.uid());

create policy "scans: update own"
on public.scans for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "scans: delete own"
on public.scans for delete
to authenticated
using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- measurements
--
-- Users may only ever read their own measurements, via a join back to scans.
-- There is deliberately no insert/update/delete policy for authenticated
-- users: the extraction worker writes measurements using the service role,
-- which bypasses RLS. A user who could edit their own measurements could
-- send garbage geometry straight to print (DESIGN 9.6/9.7 gate would be
-- pointless if the client could edit the gated value afterward).
-- ---------------------------------------------------------------------------
alter table public.measurements enable row level security;

create policy "measurements: select own via scan"
on public.measurements for select
to authenticated
using (
  scan_id in (select id from public.scans where user_id = auth.uid())
);

-- ---------------------------------------------------------------------------
-- products
--
-- Choice: allow SELECT to both anon and authenticated. The marketing site
-- (zells.com) needs to list active products before a visitor signs up, so
-- restricting to authenticated-only would break that page. Writes are
-- service-role only (admin panel), so this is a read-only public catalog,
-- not a privacy-sensitive table.
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;

create policy "products: select all"
on public.products for select
to anon, authenticated
using (true);

-- No insert/update/delete policy: catalog changes go through the admin
-- panel using the service role.

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;

create policy "orders: select own"
on public.orders for select
to authenticated
using (user_id = auth.uid());

create policy "orders: insert own"
on public.orders for insert
to authenticated
with check (user_id = auth.uid());

-- No update/delete policy: status transitions (paid, in_production,
-- shipped, cancelled, etc.) happen only via the Stripe webhook handler and
-- admin panel, both running as service role. A user must never be able to
-- mark their own order paid or cancel it post-production by editing a row.

-- ---------------------------------------------------------------------------
-- pipeline_jobs
--
-- No policies at all. This table is purely internal queue/worker state; it
-- has no legitimate end-user access pattern (reading it would leak other
-- users' processing timings/errors; writing it would let a client fake job
-- completion). Service role only, always.
-- ---------------------------------------------------------------------------
alter table public.pipeline_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- audit_log
--
-- No policies at all. Admin-only, and even the admin panel should read this
-- through a server-side API route using the service role rather than a
-- direct client query, so no "admin" RLS policy is defined here either.
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;
