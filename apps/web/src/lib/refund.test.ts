import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { canRefund, refundOrder, type RefundStripe } from './refund';

type Result = { data: unknown; error: { code?: string; message?: string } | null };

// Same recorder as shop-writes.test.ts: each awaited chain resolves with the
// next queued result for its table.
function fakeClient(results: Record<string, Result[]>) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'insert', 'update', 'eq', 'maybeSingle', 'single']) {
        builder[op] = (...args: unknown[]) => {
          entry.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => void) =>
        resolve(results[table]?.shift() ?? { data: null, error: null });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function fakeStripe(fail?: Error) {
  const create = vi.fn(async () => {
    if (fail) {
      throw fail;
    }
    return { id: 're_1', status: 'succeeded' };
  });
  return { stripe: { refunds: { create } } as RefundStripe, create };
}

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const row = (status: string, patch: Record<string, unknown> = {}) => ({
  data: { status, stripe_payment_intent: 'pi_123', refunded_at: null, ...patch },
  error: null,
});

describe('canRefund', () => {
  it('needs a payment intent, no refund yet, and not delivered', () => {
    const base = { status: 'paid', stripe_payment_intent: 'pi_1', refunded_at: null };
    expect(canRefund(base)).toBe(true);
    expect(canRefund({ ...base, status: 'shipped' })).toBe(true);
    expect(canRefund({ ...base, stripe_payment_intent: null })).toBe(false);
    expect(canRefund({ ...base, refunded_at: '2026-09-30T00:00:00Z' })).toBe(false);
    expect(canRefund({ ...base, status: 'delivered' })).toBe(false);
  });
});

describe('refundOrder', () => {
  it('refunds with an order-keyed idempotency key, audits, and cancels a paid order', async () => {
    const { client, calls } = fakeClient({
      orders: [
        row('paid'),
        // transitionOrder: its own read, then the conditional update.
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [{ id: ORDER }], error: null },
      ],
    });
    const { stripe, create } = fakeStripe();

    expect(await refundOrder(client, stripe, 'admin@x', ORDER)).toEqual({ error: null });
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123' },
      { idempotencyKey: `refund-${ORDER}` },
    );
    const audits = calls.filter((c) => c.table === 'audit_log');
    expect(audits[0]!.ops[0]).toEqual([
      'insert',
      [
        {
          actor: 'admin@x',
          action: 'order.refund',
          subject_table: 'orders',
          subject_id: ORDER,
          detail: {
            payment_intent: 'pi_123',
            refund_id: 're_1',
            refund_status: 'succeeded',
            status_at_refund: 'paid',
          },
        },
      ],
    ]);
    // The status move goes through transitionOrder (its own audit row).
    expect(audits[1]!.ops[0]![1][0]).toMatchObject({
      action: 'order.status',
      detail: { from: 'paid', to: 'cancelled' },
    });
    // refunded_at is the webhook's job, never written here.
    const updates = calls.flatMap((c) => c.ops.filter(([op]) => op === 'update'));
    expect(updates).toEqual([['update', [{ status: 'cancelled' }]]]);
  });

  it('cancels an in-production order too', async () => {
    const { client, calls } = fakeClient({
      orders: [
        row('in_production'),
        { data: { status: 'in_production', tracking_number: null }, error: null },
        { data: [{ id: ORDER }], error: null },
      ],
    });
    expect(await refundOrder(client, fakeStripe().stripe, 'a', ORDER)).toEqual({ error: null });
    expect(calls.filter((c) => c.table === 'audit_log')).toHaveLength(2);
  });

  it('refunds a shipped order without moving its status', async () => {
    const { client, calls } = fakeClient({ orders: [row('shipped')] });
    expect(await refundOrder(client, fakeStripe().stripe, 'a', ORDER)).toEqual({ error: null });
    expect(calls.map((c) => c.table)).toEqual(['orders', 'audit_log']);
  });

  it('surfaces a Stripe error as a form error and writes nothing', async () => {
    const { client, calls } = fakeClient({ orders: [row('paid')] });
    const { stripe } = fakeStripe(new Error('Charge ch_1 has already been refunded.'));
    expect(await refundOrder(client, stripe, 'a', ORDER)).toEqual({
      error: 'Stripe did not refund the payment: Charge ch_1 has already been refunded.',
    });
    expect(calls.map((c) => c.table)).toEqual(['orders']);
  });

  it.each([
    ['no payment intent', { stripe_payment_intent: null }, 'paid'],
    ['already refunded', { refunded_at: '2026-09-30T00:00:00Z' }, 'paid'],
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

  it('reports a refund that landed when the cancel lost a race', async () => {
    const { client } = fakeClient({
      orders: [
        row('paid'),
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [], error: null },
      ],
    });
    expect((await refundOrder(client, fakeStripe().stripe, 'a', ORDER)).error).toMatch(
      /^Refund issued, but the order was not cancelled: The order changed/,
    );
  });
});
