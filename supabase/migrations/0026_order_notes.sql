-- 0026_order_notes.sql
-- Admin order notes, the order timeline that shows them, and customer lookup
-- by email. docs/BUSINESS-GAPS.md rank 12, docs/DESIGN.md sections 8 and 9.
--
--   A. order_notes: internal plain-text notes on an order. Append-only,
--      service role only, idempotent per form submission (request_id).
--   B. add_order_note: note + audit row in one transaction.
--   C. admin_order_timeline: one bounded, paginated list per order from
--      audit_log (status, refunds, remakes, emails, webhooks) and order_notes.
--   D. admin_find_customers: email search over auth.users with each match's
--      account state, order counts and scan counts. A deleted account has no
--      auth user and so no email: its orders (user_id null, 0012) are found
--      by order reference instead.
--
-- Every function here is service role only; the admin panel calls them after
-- its allowlist + aal2 check. SQLSTATEs follow 0012 (22023 bad input).
--
-- Exercised by supabase/tests/order_ops_checks.sql.

-- ---------------------------------------------------------------------------
-- A. order_notes
-- ---------------------------------------------------------------------------
create table public.order_notes (
  id bigint generated always as identity primary key,
  -- CASCADE: only dead orders (cancelled, never paid) are ever deleted
  -- (0015 purge_scan_row); a note about an abandoned checkout goes with it.
  order_id uuid not null references public.orders(id) on delete cascade,
  -- 2000 matches the admin form (apps/web lib/order-notes.ts).
  body text not null
    constraint order_notes_body_length
      check (char_length(body) <= 2000 and char_length(btrim(body)) >= 1),
  author text not null constraint order_notes_author_length check (char_length(author) between 1 and 320),
  -- One per rendered note form, so a double submit stores one note.
  request_id uuid not null constraint order_notes_request_id_uq unique,
  created_at timestamptz not null default now()
);

comment on table public.order_notes is
  'Internal admin notes on an order (0026). Never shown to customers. Written only by add_order_note; append-only.';

create index order_notes_order_created_idx on public.order_notes(order_id, created_at desc);

alter table public.order_notes enable row level security;
revoke all on public.order_notes from anon, authenticated;
-- Append-only: a correction is a new note. Referential actions run as the
-- table owner, so the cascade above still works.
revoke update, delete, truncate on public.order_notes from service_role;

-- ---------------------------------------------------------------------------
-- B. add_order_note. Returns the note id (the existing one on a repeat).
-- ---------------------------------------------------------------------------
create function public.add_order_note(
  p_order_id uuid,
  p_body text,
  p_request_id uuid,
  p_actor text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id bigint;
begin
  if char_length(v_body) = 0 or char_length(v_body) > 2000 then
    raise exception 'a note is 1 to 2000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'invalid_parameter_value';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'actor is required' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  insert into public.order_notes (order_id, body, author, request_id)
  values (p_order_id, v_body, p_actor, p_request_id)
  on conflict (request_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.order_notes where request_id = p_request_id;
    return v_id;
  end if;

  -- The body stays in order_notes; the audit row records that it was added.
  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values (p_actor, 'order.note', 'orders', p_order_id,
    jsonb_build_object('note_id', v_id, 'length', char_length(v_body)));

  return v_id;
end;
$$;

comment on function public.add_order_note(uuid, text, uuid, text) is
  'Admin: append a 1-2000 character note to an order, audited. Idempotent on p_request_id. Service role only.';

revoke execute on function public.add_order_note(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.add_order_note(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- C. admin_order_timeline: newest first. The 'order.note' audit rows are left
-- out because the note itself (with its body) is listed. p_limit is clamped
-- to 1..101 (a page of 100 plus the lookahead row), p_offset to 0..10000.
-- ---------------------------------------------------------------------------
create function public.admin_order_timeline(p_order_id uuid, p_limit integer, p_offset integer)
returns table (
  source text,
  entry_id bigint,
  actor text,
  action text,
  detail jsonb,
  body text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select t.source, t.entry_id, t.actor, t.action, t.detail, t.body, t.created_at
  from (
    select 'audit'::text as source, a.id as entry_id, a.actor, a.action, a.detail,
           null::text as body, a.created_at
      from public.audit_log a
      where a.subject_table = 'orders' and a.subject_id = p_order_id and a.action <> 'order.note'
    union all
    select 'note'::text, n.id, n.author, 'order.note'::text, null::jsonb, n.body, n.created_at
      from public.order_notes n
      where n.order_id = p_order_id
  ) t
  order by t.created_at desc, t.source, t.entry_id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 101)
  offset least(greatest(coalesce(p_offset, 0), 0), 10000);
$$;

comment on function public.admin_order_timeline(uuid, integer, integer) is
  'Admin: one order''s audit rows and notes, newest first, bounded (limit 1-101, offset 0-10000). Service role only.';

revoke execute on function public.admin_order_timeline(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_order_timeline(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- D. admin_find_customers. Definer because it reads auth.users. starts_with
-- instead of LIKE, so the query text is never a pattern (no wildcard
-- escaping to get wrong). Bounded like C; the per-row counts run only for
-- the returned page.
-- ponytail: a prefix match scans auth.users (no lower(email) pattern index,
-- and migrations do not index the auth schema). Fine at Phase 0 volume.
-- ---------------------------------------------------------------------------
create function public.admin_find_customers(
  p_email text,
  p_exact boolean,
  p_limit integer,
  p_offset integer
)
returns table (
  user_id uuid,
  email text,
  is_anonymous boolean,
  created_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_reason text,
  order_count bigint,
  open_order_count bigint,
  scan_count bigint,
  scan_statuses jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_email, '')));
begin
  if char_length(v_query) < 3 or char_length(v_query) > 320 then
    raise exception 'search text must be 3 to 320 characters' using errcode = 'invalid_parameter_value';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.is_anonymous,
    u.created_at,
    r.requested_at,
    r.reason,
    (select count(*) from public.orders o where o.user_id = u.id),
    (select count(*) from public.orders o
      where o.user_id = u.id and o.status in ('paid', 'in_production', 'shipped')),
    (select count(*) from public.scans s where s.user_id = u.id and s.deleted_at is null),
    coalesce((
      select jsonb_object_agg(x.status, x.n)
      from (
        select s.status, count(*) as n
        from public.scans s
        where s.user_id = u.id and s.deleted_at is null
        group by s.status
      ) x), '{}'::jsonb)
  from auth.users u
  left join public.account_deletion_requests r on r.user_id = u.id
  where u.email is not null
    and case when coalesce(p_exact, false)
          then lower(u.email::text) = v_query
          else starts_with(lower(u.email::text), v_query)
        end
  order by lower(u.email::text), u.id
  limit least(greatest(coalesce(p_limit, 25), 1), 101)
  offset least(greatest(coalesce(p_offset, 0), 0), 10000);
end;
$$;

comment on function public.admin_find_customers(text, boolean, integer, integer) is
  'Admin: customers whose email equals (p_exact) or starts with the 3-320 character search text, with account state, order and scan counts. Bounded (limit 1-101, offset 0-10000). Service role only.';

revoke execute on function public.admin_find_customers(text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_find_customers(text, boolean, integer, integer) to service_role;
