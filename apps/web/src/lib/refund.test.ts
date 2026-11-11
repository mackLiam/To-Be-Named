import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  REFUND_MESSAGES,
  canRefund,
  nextRefundSeq,
  refundIdempotencyKey,
  refundOrder,
  refundPanelState,
  refundableRemaining,
  refundedSoFar,
  unrecordedRefunds,
  type LedgerRefund,
  type LedgerRow,
  type RefundStripe,
  type StripeRefund,
} from './refund';

type Result = { data: unknown; error: { code?: string; message?: string } | null };

// Each awaited chain resolves with the next queued result for its table;
// rpc calls resolve with the next queued result for their function.
function fakeClient(results: Record<string, Result[]>, rpcResults: Record<string, Result[]> = {}) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const rpcCalls: [string, Record<string, unknown>][] = [];
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'insert', 'update', 'eq', 'order', 'limit', 'maybeSingle']) {
        builder[op] = (...args: unknown[]) => {
          entry.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => void) =>
        resolve(results[table]?.shift() ?? { data: null, error: null });
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push([fn, args]);
      return rpcResults[fn]?.shift() ?? { data: 'recorded', error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, calls, rpcCalls };
}

function fakeStripe(
  opts: {
    fail?: Error;
    amount?: number;
    listed?: StripeRefund[];
    listFails?: Error;
    hasMore?: boolean;
  } = {},
) {
  const create = vi.fn(async (params: { payment_intent: string; amount?: number }) => {
    if (opts.fail) {
      throw opts.fail;
    }
    return { id: 're_1', status: 'succeeded', amount: opts.amount ?? params.amount ?? 17800 };
  });
  const list = vi.fn(async (_params: { payment_intent: string; limit: number }) => {
    if (opts.listFails) {
      throw opts.listFails;
    }
    return { data: opts.listed ?? [], has_more: opts.hasMore ?? false };
  });
  return { stripe: { refunds: { create, list } } as RefundStripe, create, list };
}

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const row = (status: string, patch: Record<string, unknown> = {}): Result => ({
  data: {
    status,
    stripe_payment_intent: 'pi_123',
    refunded_at: null,
    amount_cents: 17800,
    stripe_refunded_cents: null,
    products: { currency: 'usd' },
    ...patch,
  },
  error: null,
});
const ledger = (rows: LedgerRefund[] = []): Result => ({ data: rows, error: null });
const L = (seq: number, amount: number, status: string | null = 'succeeded'): LedgerRow => ({
  seq,
  amount_cents: amount,
  stripe_status: status,
  stripe_refund_id: `re_seq${seq}`,
});
/** How Stripe lists a ledger row's refund. */
const listedOf = (r: LedgerRow): StripeRefund => ({
  id: r.stripe_refund_id,
  status: r.stripe_status,
  amount: r.amount_cents,
});

describe('canRefund', () => {
  it('needs a payment intent, no full refund yet, and not delivered', () => {
    const base = { status: 'paid', stripe_payment_intent: 'pi_1', refunded_at: null };
    expect(canRefund(base)).toBe(true);
    expect(canRefund({ ...base, status: 'shipped' })).toBe(true);
    expect(canRefund({ ...base, stripe_payment_intent: null })).toBe(false);
    expect(canRefund({ ...base, refunded_at: '2026-09-30T00:00:00Z' })).toBe(false);
    expect(canRefund({ ...base, status: 'delivered' })).toBe(false);
  });
});

describe('refunded amounts', () => {
  const order = {
    status: 'shipped',
    stripe_payment_intent: 'pi_1',
    refunded_at: null,
    amount_cents: 10000,
    stripe_refunded_cents: null as number | null,
  };

  it('sums the ledger, skipping refunds that returned no money', () => {
    expect(refundedSoFar(order, [L(1, 1000), L(2, 500, 'failed'), L(3, 250, 'canceled')])).toBe(
      1000,
    );
    expect(refundedSoFar(order, [L(1, 1000), L(2, 500, null)])).toBe(1500);
  });

  it('takes the larger of ledger and Stripe total, never their sum', () => {
    // The webhook total already includes the admin refunds.
    expect(refundedSoFar({ ...order, stripe_refunded_cents: 1000 }, [L(1, 1000)])).toBe(1000);
    // A dashboard refund the ledger never saw.
    expect(refundedSoFar({ ...order, stripe_refunded_cents: 3000 }, [L(1, 1000)])).toBe(3000);
    // The webhook for the newest admin refund has not arrived yet.
    expect(refundedSoFar({ ...order, stripe_refunded_cents: 1000 }, [L(1, 1000), L(2, 400)])).toBe(
      1400,
    );
  });

  it('remaining is the charge minus refunds, and 0 when not refundable', () => {
    expect(refundableRemaining(order, [L(1, 2500)])).toBe(7500);
    expect(refundableRemaining(order, [L(1, 12000)])).toBe(0);
    expect(refundableRemaining({ ...order, status: 'delivered' }, [])).toBe(0);
    expect(refundableRemaining({ ...order, refunded_at: '2026-10-01T00:00:00Z' }, [])).toBe(0);
    expect(refundableRemaining({ ...order, amount_cents: null }, [])).toBe(0);
  });

  it('panel state offers a refund only while money remains', () => {
    expect(refundPanelState({ ...order, status: 'paid' }, [L(1, 2500)])).toEqual({
      offer: true,
      remainingCents: 7500,
      refundedCents: 2500,
      fullCancels: true,
    });
    expect(refundPanelState(order, [L(1, 10000)]).offer).toBe(false);
    expect(refundPanelState(order, []).fullCancels).toBe(false);
  });

  it('numbers refunds and caps them at 100', () => {
    expect(nextRefundSeq([])).toBe(1);
    expect(nextRefundSeq([L(1, 1), L(3, 1)])).toBe(4);
    expect(nextRefundSeq([L(100, 1)])).toBeNull();
  });

  it('keeps the original full-refund key and keys partials by seq', () => {
    expect(refundIdempotencyKey('o1', 'full', 3)).toBe('refund-o1');
    expect(refundIdempotencyKey('o1', 'partial', 3)).toBe('refund-o1-3');
  });
});

describe('refundOrder: full', () => {
  it('refunds with the order-keyed idempotency key, records it, and cancels a paid order', async () => {
    const { client, calls, rpcCalls } = fakeClient({
      orders: [
        row('paid'),
        // transitionOrder: its own read, then the conditional update.
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [{ id: ORDER }], error: null },
      ],
      order_refunds: [ledger()],
    });
    const { stripe, create } = fakeStripe();

    expect(await refundOrder(client, stripe, 'admin@x', ORDER)).toEqual({
      error: null,
      refund: {
        amountCents: 17800,
        currency: 'usd',
        kind: 'full',
        recorded: true,
        cancelled: true,
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123' },
      { idempotencyKey: `refund-${ORDER}` },
    );
    expect(rpcCalls).toEqual([
      [
        'record_order_refund',
        {
          p_order_id: ORDER,
          p_seq: 1,
          p_kind: 'full',
          p_amount_cents: 17800,
          p_stripe_refund_id: 're_1',
          p_stripe_status: 'succeeded',
          p_actor: 'admin@x',
        },
      ],
    ]);
    // The status move goes through transitionOrder (its own audit row).
    const audits = calls.filter((c) => c.table === 'audit_log');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ops[0]![1][0]).toMatchObject({
      action: 'order.status',
      detail: { from: 'paid', to: 'cancelled' },
    });
    // refunded_at is the webhook's job, never written here.
    const updates = calls.flatMap((c) => c.ops.filter(([op]) => op === 'update'));
    expect(updates).toEqual([['update', [{ status: 'cancelled' }]]]);
  });

  it('refunds only the rest after partial refunds, recording what Stripe returned', async () => {
    const { client, rpcCalls } = fakeClient({
      orders: [row('shipped')],
      order_refunds: [ledger([L(1, 2000), L(2, 800)])],
    });
    const { stripe, create } = fakeStripe({ amount: 15000 });
    const result = await refundOrder(client, stripe, 'a', ORDER);
    expect(result).toEqual({
      error: null,
      refund: {
        amountCents: 15000,
        currency: 'usd',
        kind: 'full',
        recorded: true,
        cancelled: false,
      },
    });
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123' },
      { idempotencyKey: `refund-${ORDER}` },
    );
    expect(rpcCalls[0]![1]).toMatchObject({ p_seq: 3, p_amount_cents: 15000, p_kind: 'full' });
  });

  it('refunds a shipped order without moving its status', async () => {
    const { client, calls } = fakeClient({ orders: [row('shipped')], order_refunds: [ledger()] });
    const result = await refundOrder(client, fakeStripe().stripe, 'a', ORDER);
    expect(result.error).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['orders', 'order_refunds']);
  });

  it('reports a refund that landed when the cancel lost a race', async () => {
    const { client } = fakeClient({
      orders: [
        row('paid'),
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [], error: null },
      ],
      order_refunds: [ledger()],
    });
    expect((await refundOrder(client, fakeStripe().stripe, 'a', ORDER)).error).toBe(
      'Refund issued, but the order was not cancelled. Cancel it from the status buttons.',
    );
  });
});

describe('refundOrder: partial', () => {
  it('sends the amount with a seq-keyed idempotency key and leaves status alone', async () => {
    const { client, calls, rpcCalls } = fakeClient({
      orders: [row('paid')],
      order_refunds: [ledger([L(1, 1000)])],
    });
    const { stripe, create } = fakeStripe();
    expect(await refundOrder(client, stripe, 'admin@x', ORDER, 2500)).toEqual({
      error: null,
      refund: {
        amountCents: 2500,
        currency: 'usd',
        kind: 'partial',
        recorded: true,
        cancelled: false,
      },
    });
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123', amount: 2500 },
      { idempotencyKey: `refund-${ORDER}-2` },
    );
    expect(rpcCalls[0]).toEqual([
      'record_order_refund',
      {
        p_order_id: ORDER,
        p_seq: 2,
        p_kind: 'partial',
        p_amount_cents: 2500,
        p_stripe_refund_id: 're_1',
        p_stripe_status: 'succeeded',
        p_actor: 'admin@x',
      },
    ]);
    expect(calls.flatMap((c) => c.ops.filter(([op]) => op === 'update'))).toEqual([]);
  });

  it('accepts exactly the remaining amount', async () => {
    const { client } = fakeClient({
      orders: [row('shipped', { stripe_refunded_cents: 17000 })],
      order_refunds: [ledger([L(1, 17000)])],
    });
    const result = await refundOrder(client, fakeStripe().stripe, 'a', ORDER, 800);
    expect(result.error).toBeNull();
  });

  it.each([
    ['over the remaining amount', 15001, [L(1, 2800)]],
    ['zero', 0, []],
    ['negative', -5, []],
    ['fractional cents', 10.5, []],
  ])('refuses %s without calling Stripe', async (_label, amount, rows) => {
    const { client, rpcCalls } = fakeClient({
      orders: [row('shipped')],
      order_refunds: [ledger(rows)],
    });
    const { stripe, create } = fakeStripe();
    const result = await refundOrder(client, stripe, 'a', ORDER, amount);
    expect(result.error).toBe(
      'The refund must be more than 0 and at most the amount left to refund.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('refuses an over-refund measured against the Stripe total too', async () => {
    const { client } = fakeClient({
      orders: [row('shipped', { stripe_refunded_cents: 17000 })],
      order_refunds: [ledger()],
    });
    const { stripe, create } = fakeStripe();
    expect((await refundOrder(client, stripe, 'a', ORDER, 801)).error).toBe(
      REFUND_MESSAGES.badAmount,
    );
    expect(create).not.toHaveBeenCalled();
    const exact = fakeClient({
      orders: [row('shipped', { stripe_refunded_cents: 17000 })],
      order_refunds: [ledger()],
    });
    expect(
      (await refundOrder(exact.client, fakeStripe().stripe, 'a', ORDER, 800)).error,
    ).toBeNull();
  });

  it('refuses when nothing is left, and at the 100 refund cap', async () => {
    const nothing = fakeClient({
      orders: [row('shipped', { stripe_refunded_cents: 17800 })],
      order_refunds: [ledger()],
    });
    expect((await refundOrder(nothing.client, fakeStripe().stripe, 'a', ORDER, 1)).error).toBe(
      'Nothing is left to refund on this order.',
    );
    const capped = fakeClient({
      orders: [row('shipped')],
      order_refunds: [ledger([L(100, 1)])],
    });
    const { stripe, create } = fakeStripe();
    expect((await refundOrder(capped.client, stripe, 'a', ORDER, 1)).error).toMatch(/100 refunds/);
    expect(create).not.toHaveBeenCalled();
  });

  it('a repeat that Stripe answers with the same refund is a duplicate, not a second record', async () => {
    const { client } = fakeClient(
      { orders: [row('shipped')], order_refunds: [ledger()] },
      { record_order_refund: [{ data: 'duplicate', error: null }] },
    );
    const result = await refundOrder(client, fakeStripe().stripe, 'a', ORDER, 500);
    expect(result).toMatchObject({ error: null, refund: { recorded: false } });
  });
});

describe('refundOrder: failures', () => {
  it('surfaces a Stripe error as a form error and records nothing', async () => {
    const { client, calls, rpcCalls } = fakeClient({
      orders: [row('paid')],
      order_refunds: [ledger()],
    });
    const { stripe } = fakeStripe({ fail: new Error('Charge ch_1 has already been refunded.') });
    expect(await refundOrder(client, stripe, 'a', ORDER, 100)).toEqual({
      error: REFUND_MESSAGES.stripeFailed,
    });
    expect(calls.map((c) => c.table)).toEqual(['orders', 'order_refunds']);
    expect(rpcCalls).toEqual([]);
  });

  it('reports a refund Stripe made but the ledger did not record, and does not cancel', async () => {
    const { client, calls } = fakeClient(
      { orders: [row('paid')], order_refunds: [ledger()] },
      { record_order_refund: [{ data: null, error: { message: 'connection reset' } }] },
    );
    const result = await refundOrder(client, fakeStripe().stripe, 'a', ORDER);
    expect(result.error).toBe(
      'Stripe made the refund, but this panel did not record it. Submitting a refund again records it from Stripe first and sends no new refund.',
    );
    expect(calls.filter((c) => c.table === 'audit_log')).toEqual([]);
  });

  it.each([
    ['no payment intent', { stripe_payment_intent: null }, 'paid'],
    ['already fully refunded', { refunded_at: '2026-09-30T00:00:00Z' }, 'paid'],
    ['delivered', {}, 'delivered'],
  ])('refuses an order with %s without calling Stripe', async (_label, patch, status) => {
    const { client } = fakeClient({ orders: [row(status, patch)] });
    const { stripe, create } = fakeStripe();
    expect((await refundOrder(client, stripe, 'a', ORDER)).error).toMatch(/no refundable payment/);
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a missing order', async () => {
    const { client } = fakeClient({ orders: [{ data: null, error: null }] });
    expect((await refundOrder(client, fakeStripe().stripe, 'a', ORDER)).error).toBe(
      'Order not found.',
    );
  });

  it('throws a read error rather than refunding blind', async () => {
    const { client } = fakeClient({
      orders: [row('paid')],
      order_refunds: [{ data: null, error: { message: 'ledger down' } }],
    });
    const { stripe, create } = fakeStripe();
    await expect(refundOrder(client, stripe, 'a', ORDER)).rejects.toMatchObject({
      message: 'ledger down',
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('unrecordedRefunds', () => {
  it('returns the refunds the ledger lacks, oldest first, skipping empty ones', () => {
    const listed: StripeRefund[] = [
      { id: 're_new', status: 'pending', amount: 300 },
      { id: 're_seq1', status: 'succeeded', amount: 1000 },
      { id: 're_zero', status: 'failed', amount: 0 },
      { id: 're_old', status: 'succeeded', amount: 200 },
    ];
    expect(unrecordedRefunds(listed, [L(1, 1000)]).map((r) => r.id)).toEqual(['re_old', 're_new']);
    expect(unrecordedRefunds([], [L(1, 1000)])).toEqual([]);
  });
});

describe('refundOrder: reconcile with Stripe first', () => {
  it('normal path: lists the payment, then creates with the same payload and key as before', async () => {
    const recorded = [L(1, 2000), L(2, 800)];
    const { client, rpcCalls } = fakeClient({
      orders: [row('shipped')],
      order_refunds: [ledger(recorded)],
    });
    const { stripe, create, list } = fakeStripe({ listed: recorded.map(listedOf).reverse() });
    const result = await refundOrder(client, stripe, 'admin@x', ORDER, 2500);
    expect(result.error).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_123', limit: 100 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123', amount: 2500 },
      { idempotencyKey: `refund-${ORDER}-3` },
    );
    expect(list.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
    // Only the new refund is recorded.
    expect(rpcCalls).toEqual([
      [
        'record_order_refund',
        {
          p_order_id: ORDER,
          p_seq: 3,
          p_kind: 'partial',
          p_amount_cents: 2500,
          p_stripe_refund_id: 're_1',
          p_stripe_status: 'succeeded',
          p_actor: 'admin@x',
        },
      ],
    ]);
  });

  it('records a refund Stripe made but the ledger lost, and the retry offers less', async () => {
    // Seq 2 (25.00) went through at Stripe, then record_order_refund failed.
    const lost: StripeRefund = { id: 're_lost', status: 'succeeded', amount: 2500 };
    const listed = [lost, listedOf(L(1, 2000))];
    const first = fakeClient({ orders: [row('shipped')], order_refunds: [ledger([L(1, 2000)])] });
    const s1 = fakeStripe({ listed });
    const order = row('shipped').data as Parameters<typeof refundPanelState>[0];

    expect(refundPanelState(order, [L(1, 2000)]).remainingCents).toBe(15800);
    expect(await refundOrder(first.client, s1.stripe, 'admin@x', ORDER, 2500)).toEqual({
      error: REFUND_MESSAGES.reconciled,
    });
    // Recorded before anything else, at the next seq, and nothing new was sent.
    expect(first.rpcCalls).toEqual([
      [
        'record_order_refund',
        {
          p_order_id: ORDER,
          p_seq: 2,
          p_kind: 'partial',
          p_amount_cents: 2500,
          p_stripe_refund_id: 're_lost',
          p_stripe_status: 'succeeded',
          p_actor: 'admin@x',
        },
      ],
    ]);
    expect(s1.create).not.toHaveBeenCalled();

    // The ledger now holds it: the panel offers 25.00 less than before.
    const after: LedgerRow[] = [
      L(1, 2000),
      { seq: 2, amount_cents: 2500, stripe_status: 'succeeded', stripe_refund_id: 're_lost' },
    ];
    expect(refundPanelState(order, after).remainingCents).toBe(13300);

    // A retry above the corrected remaining amount is refused without Stripe.
    const over = fakeClient({ orders: [row('shipped')], order_refunds: [ledger(after)] });
    const s2 = fakeStripe({ listed });
    expect((await refundOrder(over.client, s2.stripe, 'admin@x', ORDER, 15000)).error).toBe(
      REFUND_MESSAGES.badAmount,
    );
    expect(s2.create).not.toHaveBeenCalled();
    expect(over.rpcCalls).toEqual([]);

    // A retry within it goes ahead on seq 3, a key that never refunded before.
    const ok = fakeClient({ orders: [row('shipped')], order_refunds: [ledger(after)] });
    const s3 = fakeStripe({ listed });
    expect((await refundOrder(ok.client, s3.stripe, 'admin@x', ORDER, 1000)).error).toBeNull();
    expect(s3.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123', amount: 1000 },
      { idempotencyKey: `refund-${ORDER}-3` },
    );
  });

  it('records several lost refunds oldest first, and a lost full refund as full', async () => {
    const { client, rpcCalls } = fakeClient({ orders: [row('paid')], order_refunds: [ledger()] });
    const { stripe, create } = fakeStripe({
      listed: [
        { id: 're_b', status: 'pending', amount: 17800 },
        { id: 're_a', status: 'failed', amount: 500 },
      ],
    });
    expect((await refundOrder(client, stripe, 'admin@x', ORDER)).error).toBe(
      REFUND_MESSAGES.reconciled,
    );
    expect(rpcCalls.map(([, args]) => args)).toEqual([
      expect.objectContaining({
        p_seq: 1,
        p_kind: 'partial',
        p_stripe_refund_id: 're_a',
        p_stripe_status: 'failed',
      }),
      expect.objectContaining({
        p_seq: 2,
        p_kind: 'full',
        p_stripe_refund_id: 're_b',
        p_amount_cents: 17800,
      }),
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('a listing failure blocks the refund', async () => {
    const { client, rpcCalls, calls } = fakeClient({
      orders: [row('paid')],
      order_refunds: [ledger()],
    });
    const { stripe, create } = fakeStripe({ listFails: new Error('api down') });
    expect(await refundOrder(client, stripe, 'a', ORDER)).toEqual({
      error:
        'Stripe could not list the refunds already made on this payment, so no new refund was sent. Try again in a minute.',
    });
    expect(create).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(calls.flatMap((c) => c.ops.filter(([op]) => op === 'update'))).toEqual([]);
  });

  it('refuses when Stripe has more refunds than one page, or one cannot be recorded', async () => {
    const more = fakeClient({ orders: [row('paid')], order_refunds: [ledger()] });
    const s1 = fakeStripe({ hasMore: true });
    expect((await refundOrder(more.client, s1.stripe, 'a', ORDER)).error).toBe(
      REFUND_MESSAGES.tooMany,
    );
    expect(s1.create).not.toHaveBeenCalled();

    const broken = fakeClient(
      { orders: [row('paid')], order_refunds: [ledger()] },
      { record_order_refund: [{ data: null, error: { code: '23514', message: 'shape' } }] },
    );
    const s2 = fakeStripe({ listed: [{ id: 're_x', status: 'succeeded', amount: 100 }] });
    expect((await refundOrder(broken.client, s2.stripe, 'a', ORDER)).error).toBe(
      REFUND_MESSAGES.reconcileFailed,
    );
    expect(s2.create).not.toHaveBeenCalled();
  });
});
