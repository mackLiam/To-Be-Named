-- 0010_scan_pairs.sql
-- Group the two leg captures of one scan session.
--
-- A "scan" in the product is both legs: the user captures the left leg and
-- the right leg back to back, and the library shows that pair as one entry
-- (an order then points its scan_id_left / scan_id_right at the pair's rows).
-- The scans table stays one row per leg, because the pipeline measures each
-- leg independently; pair_id is the grouping key the capture flow stamps on
-- both legs of one session.
--
-- Deliberately a bare uuid column, not a FK to a sessions table: the pair has
-- no data of its own (its date is its legs' dates), and every read of it is
-- already scoped by "scans: select own" RLS, so a pair_id reused across users
-- can only ever group a user's own rows. Nullable so single-leg scans (and
-- rows captured before this migration) stay valid; the app lists those as a
-- one-leg entry.

alter table public.scans add column pair_id uuid;

comment on column public.scans.pair_id is
  'Client-generated uuid shared by the left and right leg rows of one scan session. Null for a single-leg scan.';

-- At most one left and one right per pair. A rescan of one leg starts a new
-- pair rather than overwriting history.
create unique index scans_pair_leg_uq on public.scans(pair_id, leg)
  where pair_id is not null;

-- The library query: a user's scans, newest first, LIMIT-capped.
create index scans_user_created_idx on public.scans(user_id, created_at desc);
