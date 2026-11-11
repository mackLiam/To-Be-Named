-- Behavioral checks for 0024_order_remakes.sql, 0025_order_refunds.sql and
-- 0026_order_notes.sql: remake creation (CAD jobs, idempotency, refusals),
-- the remake and refund constraints, the refund ledger and webhook total,
-- notes, the timeline, customer lookup, and that clients can read their own
-- remake orders but write nothing. Fixtures are written as the superuser;
-- roles are switched only for the privilege checks. Run by run_sql_checks.sh.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks24;
grant usage on schema checks24 to anon, authenticated, service_role;

create function checks24.expect_error(p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected SQLSTATE % but succeeded: %', p_state, p_sql;
exception when others then
  if sqlstate <> p_state then
    raise exception 'expected SQLSTATE %, got % (%): %', p_state, sqlstate, sqlerrm, p_sql;
  end if;
end;
$$;

create function checks24.rows_affected(p_sql text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function checks24.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema checks24 to anon, authenticated, service_role;

\set ua '24000000-0000-0000-0000-00000000000a'
\set ub '24000000-0000-0000-0000-00000000000b'
\set ug '24000000-0000-0000-0000-00000000000c'
\set p '24000000-1111-0000-0000-000000000001'
\set p_nocad '24000000-1111-0000-0000-000000000002'
\set sl '24000000-2222-0000-0000-000000000001'
\set sr '24000000-2222-0000-0000-000000000002'
\set sb '24000000-2222-0000-0000-000000000003'
\set sx '24000000-2222-0000-0000-000000000004'
\set o_ship '24000000-3333-0000-0000-000000000001'
\set o_prod '24000000-3333-0000-0000-000000000002'
\set o_b '24000000-3333-0000-0000-000000000003'
\set o_gone '24000000-3333-0000-0000-000000000004'
\set o_nocad '24000000-3333-0000-0000-000000000005'
\set o_left '24000000-3333-0000-0000-000000000006'
\set rq1 '24000000-4444-0000-0000-000000000001'
\set rq2 '24000000-4444-0000-0000-000000000002'

insert into auth.users (id, email, is_anonymous) values
  (:'ua', 'ops.alpha@example.test', false),
  (:'ub', 'ops.beta@example.test', false),
  (:'ug', null, true);
insert into public.account_deletion_requests (user_id, reason) values (:'ub', 'user_request');

insert into public.products (id, name, slug, base_price_cents, availability, cad_model) values
  (:'p', 'Ops24', 'ops-24', 8900, 'available', '{"provider":"dry_run"}'),
  (:'p_nocad', 'NoCad24', 'nocad-24', 8900, 'coming_soon', null);

insert into public.scans (id, user_id, leg, status) values
  (:'sl', :'ua', 'L', 'ready'),
  (:'sr', :'ua', 'R', 'ready'),
  (:'sb', :'ub', 'L', 'ready'),
  (:'sx', :'ua', 'L', 'failed');
insert into public.measurements (scan_id, schema_version, extraction_version, "values", validated)
  select s, '1.0.0', 'x', '{}', true from unnest(array[:'sl', :'sr', :'sb']::uuid[]) s;

-- Inserted past 'paid' so the fixtures enqueue no CAD jobs of their own.
insert into public.orders
  (id, user_id, product_id, scan_id_left, scan_id_right, status, amount_cents, stripe_payment_intent, address)
values
  (:'o_ship', :'ua', :'p', :'sl', :'sr', 'shipped', 17800, 'pi_ops24_1', '{"name":"A","line1":"1 St"}'),
  (:'o_prod', :'ua', :'p', :'sl', null, 'in_production', 8900, 'pi_ops24_2', null),
  (:'o_b', :'ub', :'p', :'sb', null, 'delivered', 8900, 'pi_ops24_3', null),
  (:'o_gone', null, :'p', :'sl', null, 'delivered', 8900, 'pi_ops24_4', null),
  (:'o_nocad', :'ua', :'p_nocad', :'sl', null, 'shipped', 8900, 'pi_ops24_5', null),
  (:'o_left', :'ua', :'p', :'sl', null, 'delivered', 8900, 'pi_ops24_6', null);

-- ===========================================================================
-- 0024 remakes
-- ===========================================================================
set role service_role;

create temp table r1 as
  select * from public.create_order_remake(:'o_ship', 'fit_too_tight', null, 'both', 'admin@example.test');
select checks24.eq((select outcome from r1), 'created', 'remake created');

select checks24.eq(
  (select format('%s/%s/%s/%s/%s/%s/%s', o.status, o.amount_cents, o.remake_of, o.remake_reason,
                 o.scan_id_left, o.scan_id_right, o.user_id)
     from public.orders o where o.id = (select remake_id from r1)),
  format('paid/0/%s/fit_too_tight/%s/%s/%s', :'o_ship', :'sl', :'sr', :'ua'),
  'remake is a paid zero-cost order on the same scans and customer');
select checks24.eq(
  (select paid_at is not null and stripe_payment_intent is null and stripe_checkout_session_id is null
          and address = '{"name":"A","line1":"1 St"}'::jsonb
     from public.orders where id = (select remake_id from r1)), true,
  'remake has paid_at, no Stripe ids, and the original address');
select checks24.eq(
  (select count(*) from public.pipeline_jobs
     where order_id = (select remake_id from r1) and step = 'generating_cad' and status = 'pending')::int, 2,
  'remake enqueued one CAD job per leg through the paid trigger');
select checks24.eq(
  (select count(*) from public.audit_log where subject_id = :'o_ship' and action = 'order.remake')::int, 1,
  'remake audited on the original');
select checks24.eq(
  (select detail ->> 'remake_of' from public.audit_log
     where subject_id = (select remake_id from r1) and action = 'order.remake_created'),
  :'o_ship', 'remake audited on the new order, pointing back');

-- Double click: same order again returns the open remake.
select checks24.eq(
  (select remake_id = (select remake_id from r1) and outcome = 'duplicate'
     from public.create_order_remake(:'o_ship', 'print_defect', null, 'left', 'admin@example.test')), true,
  'a second call returns the open remake as duplicate');
select checks24.eq(
  (select count(*) from public.orders where remake_of = :'o_ship')::int, 1, 'still one remake');
select checks24.eq(
  (select count(*) from public.audit_log where subject_id = :'o_ship' and action = 'order.remake')::int, 1,
  'a duplicate call writes no audit row');

-- Refusals.
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_prod', 'print_defect', 'both', 'a'),
  '23514');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_gone', 'print_defect', 'both', 'a'),
  '23514');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, %L, %L, %L)', :'o_left', 'other', '   ', 'both', 'a'),
  '22023');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, %L, %L, %L)', :'o_left', 'other', repeat('n', 501), 'both', 'a'),
  '22023');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_left', 'too_ugly', 'both', 'a'),
  '22023');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_left', 'print_defect', 'right', 'a'),
  '22023');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_left', 'print_defect', 'both', ' '),
  '22023');
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)',
         '24000000-3333-0000-0000-0000000000ff', 'print_defect', 'both', 'a'),
  'P0002');
-- The paid trigger refuses a product without a CAD model; nothing is kept.
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_nocad', 'print_defect', 'both', 'a'),
  '23514');
select checks24.eq(
  (select count(*) from public.orders where remake_of = :'o_nocad')::int, 0,
  'a refused remake leaves no order behind');

-- 'other' with a 500 character note is accepted; the note goes to the audit
-- detail only, and a single-leg pick takes that leg.
select checks24.eq(
  (select outcome from public.create_order_remake(:'o_left', 'other', repeat('n', 500), 'left', 'a')),
  'created', 'other with a 500 character note is accepted');
select checks24.eq(
  (select char_length(detail ->> 'note') from public.audit_log
     where subject_id = :'o_left' and action = 'order.remake'), 500,
  'the remake note is kept in the audit detail');
reset role;

-- Cancelling the open remake allows a new one; the cancelled one's queued
-- jobs are dead-lettered by the 0013 trigger.
update public.orders set status = 'cancelled' where id = (select remake_id from r1);
select checks24.eq(
  (select count(*) from public.pipeline_jobs
     where order_id = (select remake_id from r1) and status = 'dead_letter')::int, 2,
  'cancelling a remake dead-letters its CAD jobs');
create temp table r2 as
  select * from public.create_order_remake(:'o_ship', 'damaged_in_transit', null, 'right', 'a');
select checks24.eq(
  (select format('%s/%s/%s', r2.outcome, o.scan_id_left, o.scan_id_right)
     from r2 join public.orders o on o.id = r2.remake_id),
  format('created//%s', :'sr'), 'after a cancel, a right-leg remake is created');
grant select on r2 to authenticated, service_role;

-- A remake of a remake is allowed once it has shipped.
update public.orders set status = 'shipped' where id = (select remake_id from r2);
select checks24.eq(
  (select outcome from public.create_order_remake((select remake_id from r2), 'wrong_item', null, 'both', 'a')),
  'created', 'a shipped remake can itself be remade');

-- Constraints.
select checks24.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status, remake_of, remake_reason) values (%L, %L, %L, %L, %L, %L)',
         :'ua', :'p', :'sl', 'paid', :'o_ship', 'print_defect'),
  '23505');
select checks24.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status, amount_cents, remake_of, remake_reason) values (%L, %L, %L, %L, 100, %L, %L)',
         :'ua', :'p', :'sl', 'delivered', :'o_b', 'print_defect'),
  '23514');
select checks24.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status, stripe_payment_intent, remake_of, remake_reason) values (%L, %L, %L, %L, %L, %L, %L)',
         :'ua', :'p', :'sl', 'delivered', 'pi_ops24_x', :'o_b', 'print_defect'),
  '23514');
select checks24.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status, remake_of) values (%L, %L, %L, %L, %L)',
         :'ua', :'p', :'sl', 'delivered', :'o_b'),
  '23514');
select checks24.expect_error(
  format('update public.orders set remake_reason = %L where id = %L', 'too_ugly', (select remake_id from r2)),
  '23514');
select checks24.expect_error(
  format('update public.orders set remake_of = id where id = %L', (select remake_id from r2)),
  '23514');
select checks24.expect_error(
  format('update public.orders set amount_cents = 500 where id = %L', (select remake_id from r2)),
  '23514');
select checks24.expect_error(
  format('delete from public.orders where id = %L', :'o_ship'), '23001');

-- Clients: no RPC, read only their own remake rows, no writes.
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_ship', 'print_defect', 'both', 'a'),
  '42501');
select checks24.eq(
  (select count(*) from public.orders where remake_of is not null)::int, 4,
  'the customer sees all four of their remake orders');
select checks24.eq(
  (select remake_reason from public.orders where id = (select remake_id from r2)), 'damaged_in_transit',
  'the customer can read the remake link and reason');
select checks24.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status, amount_cents, remake_of, remake_reason) values (%L, %L, %L, %L, 0, %L, %L)',
         :'ua', :'p', :'sl', 'paid', :'o_left', 'print_defect'),
  '42501');
select checks24.eq(
  checks24.rows_affected(format('update public.orders set remake_reason = %L where remake_of is not null', 'other')), 0,
  'the customer cannot update a remake');
select checks24.eq(
  checks24.rows_affected('delete from public.orders where remake_of is not null'), 0,
  'the customer cannot delete a remake');
select set_config('request.jwt.claim.sub', :'ub', false);
select checks24.eq(
  (select count(*) from public.orders where remake_of is not null)::int, 0,
  'another customer sees none of them');
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false);
select checks24.expect_error(
  format('select * from public.create_order_remake(%L, %L, null, %L, %L)', :'o_ship', 'print_defect', 'both', 'a'),
  '42501');
select checks24.eq((select count(*) from public.orders)::int, 0, 'anon reads no orders');
reset role;

-- ===========================================================================
-- 0025 refunds
-- ===========================================================================
set role service_role;
select checks24.eq(
  public.record_order_refund(:'o_ship', 1, 'partial', 500, 're_ops24a', 'succeeded', 'admin@example.test'),
  'recorded', 'partial refund recorded');
select checks24.eq(
  public.record_order_refund(:'o_ship', 1, 'partial', 500, 're_ops24a', 'succeeded', 'admin@example.test'),
  'duplicate', 'the same Stripe refund is recorded once');
-- Another refund raced onto seq 1: kept, after the others.
select checks24.eq(
  public.record_order_refund(:'o_ship', 1, 'partial', 700, 're_ops24b', 'pending', 'admin@example.test'),
  'recorded', 'a different refund on a taken seq is recorded');
select checks24.eq(
  (select string_agg(seq || ':' || amount_cents, ',' order by seq) from public.order_refunds where order_id = :'o_ship'),
  '1:500,2:700', 'the ledger keeps both refunds in order');
select checks24.eq(
  (select count(*) from public.audit_log where subject_id = :'o_ship' and action = 'order.refund')::int, 2,
  'each recorded refund is audited once');
select checks24.eq(
  (select detail ->> 'amount_cents' || '/' || (detail ->> 'kind') || '/' || (detail ->> 'status_at_refund')
     from public.audit_log where subject_id = :'o_ship' and action = 'order.refund' and detail ->> 'refund_id' = 're_ops24a'),
  '500/partial/shipped', 'the refund audit carries amount, kind and status');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 3, %L, 0, %L, null, %L)', :'o_ship', 'partial', 're_ops24c', 'a'), '23514');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 101, %L, 10, %L, null, %L)', :'o_b', 'partial', 're_ops24d', 'a'), '23514');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 1, %L, 10, %L, null, %L)', :'o_b', 'half', 're_ops24e', 'a'), '23514');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 1, %L, 10, %L, null, %L)', :'o_b', 'partial', 'not a refund id', 'a'), '23514');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 1, %L, 10, %L, null, %L)',
         (select remake_id from r2), 'partial', 're_ops24f', 'a'), '23514');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 1, %L, 10, %L, null, %L)',
         '24000000-3333-0000-0000-0000000000ff', 'partial', 're_ops24g', 'a'), 'P0002');
-- Append-only, even for the service role.
select checks24.expect_error(
  format('update public.order_refunds set amount_cents = 1 where order_id = %L', :'o_ship'), '42501');
select checks24.expect_error(
  format('delete from public.order_refunds where order_id = %L', :'o_ship'), '42501');

-- Webhook total: a high-water mark that never double counts the ledger.
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_1', 'pi_ops24_1', false, 1200), 'applied',
  'webhook partial refund applied');
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_0', 'pi_ops24_1', false, 500), 'applied',
  'an older, smaller event applies');
select checks24.eq(
  (select coalesce(stripe_refunded_cents, -1) || '/' || (refunded_at is null)
     from public.orders where id = :'o_ship'),
  '1200/true', 'a late smaller total never lowers the stored total; partial leaves refunded_at null');
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_1', 'pi_ops24_1', false, 9999), 'duplicate',
  'a replayed event is a duplicate');
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_2', 'pi_ops24_1', true, 17800), 'applied',
  'webhook full refund applied');
select checks24.eq(
  (select stripe_refunded_cents || '/' || (refunded_at is not null) || '/' || status
     from public.orders where id = :'o_ship'),
  '17800/true/shipped', 'full refund stamps refunded_at, keeps the total, never moves status');
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_3', 'pi_ops24_nope', true, 100), 'ignored',
  'an unknown payment is ignored');
select checks24.eq(
  public.stripe_charge_refunded_amount('evt_ops24_4', 'pi_ops24_3', false, null), 'applied',
  'an event without an amount applies');
select checks24.eq(
  (select stripe_refunded_cents from public.orders where id = :'o_b'), null::integer,
  'an event without an amount stores no total');
select checks24.eq(
  (select count(*) from public.order_refunds where order_id = :'o_ship')::int, 2,
  'webhook events never write the admin ledger');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks24.expect_error('select count(*) from public.order_refunds', '42501');
select checks24.expect_error(
  format('insert into public.order_refunds (order_id, seq, kind, amount_cents, stripe_refund_id, actor) values (%L, 9, %L, 1, %L, %L)',
         :'o_ship', 'partial', 're_ops24h', 'me'), '42501');
select checks24.expect_error(
  format('select public.record_order_refund(%L, 9, %L, 1, %L, null, %L)', :'o_ship', 'partial', 're_ops24i', 'me'), '42501');
select checks24.expect_error(
  format('select public.stripe_charge_refunded_amount(%L, %L, true, 1)', 'evt_ops24_x', 'pi_ops24_1'), '42501');
select checks24.eq(
  (select stripe_refunded_cents from public.orders where id = :'o_ship'), 17800,
  'the customer can read the refunded total on their own order');
reset role;

-- ===========================================================================
-- 0026 notes, timeline, customer lookup
-- ===========================================================================
set role service_role;
create temp table n1 as select public.add_order_note(:'o_ship', '  Called the customer.  ', :'rq1', 'admin@example.test') as id;
select checks24.eq(
  public.add_order_note(:'o_ship', 'Called the customer.', :'rq1', 'admin@example.test'), (select id from n1),
  'a repeated submission returns the same note');
select checks24.eq(
  (select string_agg(body, '|') from public.order_notes where order_id = :'o_ship'), 'Called the customer.',
  'one note, stored trimmed');
select checks24.eq(
  (select count(*) from public.audit_log where subject_id = :'o_ship' and action = 'order.note')::int, 1,
  'the note is audited once');
select checks24.expect_error(
  format('select public.add_order_note(%L, %L, %L, %L)', :'o_ship', '   ', :'rq2', 'a'), '22023');
select checks24.expect_error(
  format('select public.add_order_note(%L, %L, %L, %L)', :'o_ship', repeat('x', 2001), :'rq2', 'a'), '22023');
select checks24.expect_error(
  format('select public.add_order_note(%L, %L, null, %L)', :'o_ship', 'x', 'a'), '22023');
select checks24.expect_error(
  format('select public.add_order_note(%L, %L, %L, %L)', '24000000-3333-0000-0000-0000000000ff', 'x', :'rq2', 'a'), 'P0002');
select checks24.eq(
  public.add_order_note(:'o_ship', repeat('x', 2000), :'rq2', 'admin@example.test') > (select id from n1), true,
  'a 2000 character note is accepted');
select checks24.expect_error(
  format('update public.order_notes set body = %L where order_id = %L', 'edited', :'o_ship'), '42501');
select checks24.expect_error(
  format('delete from public.order_notes where order_id = %L', :'o_ship'), '42501');

-- Timeline: notes with their body, audit rows, no duplicate 'order.note' rows.
select checks24.eq(
  (select count(*) from public.admin_order_timeline(:'o_ship', 100, 0) where source = 'note')::int, 2,
  'timeline lists both notes');
select checks24.eq(
  (select count(*) from public.admin_order_timeline(:'o_ship', 100, 0) where source = 'audit' and action = 'order.note')::int, 0,
  'timeline leaves out the note audit rows');
select checks24.eq(
  (select count(*) from public.admin_order_timeline(:'o_ship', 100, 0)
     where action in ('order.remake', 'order.refund', 'stripe.charge.refunded'))::int, 2 + 2 + 3,
  'timeline includes remakes, refunds and webhook events');
select checks24.eq(
  (select count(*) from public.admin_order_timeline(:'o_ship', 2, 0))::int, 2, 'timeline honours the limit');
select checks24.eq(
  (select count(*) from public.admin_order_timeline(:'o_ship', 0, -5))::int, 1, 'limit and offset are clamped');
select checks24.eq(
  (select bool_and(a.created_at >= b.created_at)
     from (select created_at, row_number() over () as i from public.admin_order_timeline(:'o_ship', 100, 0)) a
     join (select created_at, row_number() over () as i from public.admin_order_timeline(:'o_ship', 100, 0)) b
       on b.i = a.i + 1),
  true, 'timeline is newest first');

-- Customer lookup.
select checks24.eq(
  (select string_agg(email, ',' order by email) from public.admin_find_customers('OPS.', false, 25, 0)),
  'ops.alpha@example.test,ops.beta@example.test', 'prefix search is case-insensitive and ordered');
select checks24.eq(
  (select format('%s/%s/%s/%s/%s', user_id, order_count, open_order_count, scan_count, scan_statuses)
     from public.admin_find_customers('ops.alpha@example.test', true, 25, 0)),
  format('%s/8/6/3/{"ready": 2, "failed": 1}', :'ua'),
  'exact search returns the account with its order and scan counts');
select checks24.eq(
  (select deletion_reason from public.admin_find_customers('ops.beta@example.test', true, 25, 0)), 'user_request',
  'a pending account deletion is reported');
select checks24.eq(
  (select count(*) from public.admin_find_customers('ops.alpha', true, 25, 0))::int, 0,
  'exact search does not prefix match');
select checks24.eq(
  (select count(*) from public.admin_find_customers('ops%', false, 25, 0))::int, 0,
  'search text is never a LIKE pattern');
select checks24.eq(
  (select count(*) from public.admin_find_customers('ops.', false, 1, 0))::int, 1, 'lookup honours the limit');
select checks24.eq(
  (select email from public.admin_find_customers('ops.', false, 1, 1)), 'ops.beta@example.test',
  'lookup pages by offset');
select checks24.expect_error('select * from public.admin_find_customers(''op'', false, 25, 0)', '22023');
select checks24.expect_error(
  format('select * from public.admin_find_customers(%L, false, 25, 0)', repeat('a', 321)), '22023');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks24.expect_error('select count(*) from public.order_notes', '42501');
select checks24.expect_error(
  format('select public.add_order_note(%L, %L, %L, %L)', :'o_ship', 'x', '24000000-4444-0000-0000-000000000009', 'me'), '42501');
select checks24.expect_error(
  format('select * from public.admin_order_timeline(%L, 10, 0)', :'o_ship'), '42501');
select checks24.expect_error('select * from public.admin_find_customers(''ops.'', false, 25, 0)', '42501');
reset role;

set role anon;
select checks24.expect_error('select * from public.admin_find_customers(''ops.'', false, 25, 0)', '42501');
select checks24.expect_error('select count(*) from public.order_notes', '42501');
reset role;

select checks24.eq(
  (select bool_or(has_function_privilege('public', f, 'execute'))
     from unnest(array[
       'public.create_order_remake(uuid, text, text, text, text)',
       'public.record_order_refund(uuid, integer, text, integer, text, text, text)',
       'public.stripe_charge_refunded_amount(text, text, boolean, integer)',
       'public.add_order_note(uuid, text, uuid, text)',
       'public.admin_order_timeline(uuid, integer, integer)',
       'public.admin_find_customers(text, boolean, integer, integer)']) f), false,
  'no new function is executable by PUBLIC');

-- ---------------------------------------------------------------------------
-- Cleanup (later check files reuse the cluster and count rows globally).
-- ---------------------------------------------------------------------------
delete from public.pipeline_jobs
  where order_id in (select id from public.orders where product_id in (:'p', :'p_nocad'));
delete from public.order_refunds where order_id in (select id from public.orders where product_id in (:'p', :'p_nocad'));
delete from public.audit_log
  where subject_id in (select id from public.orders where product_id in (:'p', :'p_nocad'));
delete from public.stripe_events where id like 'evt_ops24_%';
-- Remakes first: remake_of is ON DELETE RESTRICT. Notes cascade.
delete from public.orders where remake_of is not null and product_id = :'p'
  and id not in (select remake_of from public.orders where remake_of is not null);
delete from public.orders where remake_of is not null and product_id = :'p';
delete from public.orders where product_id in (:'p', :'p_nocad');
select checks24.eq(
  (select count(*) from public.order_notes where request_id in (:'rq1', :'rq2'))::int, 0,
  'deleting an order cascades to its notes');
delete from public.measurements where scan_id in (:'sl', :'sr', :'sb');
delete from public.scans where id in (:'sl', :'sr', :'sb', :'sx');
delete from public.products where id in (:'p', :'p_nocad');
delete from auth.users where id in (:'ua', :'ub', :'ug');
drop schema checks24 cascade;
