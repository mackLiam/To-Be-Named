import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { createProduct, moveProduct, transitionOrder } from './shop-writes';

type Result = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * Minimal stand-in for the supabase-js query builder: records every call
 * per table and resolves each awaited chain with the next queued result for
 * that table. Enough to see which writes happened and with which filters.
 */
function fakeClient(results: Record<string, Result[]>) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const op of [
        'select',
        'insert',
        'update',
        'eq',
        'order',
        'limit',
        'maybeSingle',
        'single',
      ]) {
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

const ORDER = '00000000-0000-4000-8000-0000000000a1';

describe('transitionOrder', () => {
  it('updates conditionally on the read status and audits the move', async () => {
    const { client, calls } = fakeClient({
      orders: [
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [{ id: ORDER }], error: null },
      ],
    });
    expect(await transitionOrder(client, 'admin@x', ORDER, 'in_production')).toEqual({
      error: null,
    });
    const update = calls[1]!;
    expect(update.ops).toContainEqual(['update', [{ status: 'in_production' }]]);
    expect(update.ops).toContainEqual(['eq', ['status', 'paid']]);
    const auditCall = calls[2]!;
    expect(auditCall.table).toBe('audit_log');
    expect(auditCall.ops[0]![1][0]).toMatchObject({
      actor: 'admin@x',
      action: 'order.status',
      subject_table: 'orders',
      subject_id: ORDER,
      detail: { from: 'paid', to: 'in_production' },
    });
  });

  it('refuses a disallowed move without writing', async () => {
    const { client, calls } = fakeClient({
      orders: [{ data: { status: 'in_production', tracking_number: null }, error: null }],
    });
    const result = await transitionOrder(client, 'admin@x', ORDER, 'shipped');
    expect(result.error).toMatch(/tracking number/);
    expect(calls).toHaveLength(1);
  });

  it('reports a concurrent change and skips the audit', async () => {
    const { client, calls } = fakeClient({
      orders: [
        { data: { status: 'paid', tracking_number: null }, error: null },
        { data: [], error: null },
      ],
    });
    const result = await transitionOrder(client, 'admin@x', ORDER, 'cancelled');
    expect(result.error).toMatch(/changed/);
    expect(calls.map((c) => c.table)).toEqual(['orders', 'orders']);
  });

  it('shows the paid trigger refusal instead of throwing', async () => {
    const { client, calls } = fakeClient({
      orders: [
        { data: { status: 'pending_payment', tracking_number: null }, error: null },
        {
          data: null,
          error: { code: '23514', message: 'scan has no measurements yet' },
        },
      ],
    });
    const result = await transitionOrder(client, 'admin@x', ORDER, 'paid');
    expect(result.error).toBe('scan has no measurements yet');
    expect(calls.map((c) => c.table)).toEqual(['orders', 'orders']);
  });

  it('reports a missing order', async () => {
    const { client } = fakeClient({ orders: [{ data: null, error: null }] });
    expect((await transitionOrder(client, 'a', ORDER, 'paid')).error).toBe('Order not found.');
  });
});

describe('createProduct', () => {
  const input = {
    name: 'Guard',
    slug: 'guard',
    description: '',
    base_price_cents: 8900,
    currency: 'usd',
    image_url: null,
    active: true,
    cad_model: null,
    display_order: 0,
    availability: 'coming_soon' as const,
    sizing_modes: ['custom' as const],
  };

  it('turns a unique violation into a form error', async () => {
    const { client, calls } = fakeClient({
      products: [{ data: null, error: { code: '23505' } }],
    });
    expect((await createProduct(client, 'a', input)).error).toMatch(/already used/);
    expect(calls).toHaveLength(1);
  });

  it('throws unexpected database errors', async () => {
    const { client } = fakeClient({ products: [{ data: null, error: { code: '42501' } }] });
    await expect(createProduct(client, 'a', input)).rejects.toEqual({ code: '42501' });
  });
});

describe('moveProduct', () => {
  const P = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;
  const rows = [
    { id: P(1), name: 'A', display_order: 0 },
    { id: P(2), name: 'B', display_order: 0 },
    { id: P(3), name: 'C', display_order: 0 },
  ];

  it('normalizes ties on the first move and audits it', async () => {
    const { client, calls } = fakeClient({ products: [{ data: rows, error: null }] });
    expect(await moveProduct(client, 'a@x', P(3), 'up')).toEqual({ error: null });
    const updates = calls
      .filter((c) => c.table === 'products')
      .slice(1)
      .map((c) => [c.ops[0]![1][0], c.ops[1]![1]]);
    expect(updates).toEqual([
      [{ display_order: 1 }, ['id', P(3)]],
      [{ display_order: 2 }, ['id', P(2)]],
    ]);
    const auditCall = calls.find((c) => c.table === 'audit_log')!;
    expect(auditCall.ops[0]![1][0]).toMatchObject({
      action: 'product.reorder',
      subject_table: 'products',
      subject_id: P(3),
      detail: { direction: 'up' },
    });
  });

  it('writes nothing at the top of the list', async () => {
    const { client, calls } = fakeClient({ products: [{ data: rows, error: null }] });
    expect(await moveProduct(client, 'a@x', P(1), 'up')).toEqual({ error: null });
    expect(calls).toHaveLength(1);
  });

  it('reports an unknown product', async () => {
    const { client } = fakeClient({ products: [{ data: rows, error: null }] });
    expect((await moveProduct(client, 'a@x', P(9), 'down')).error).toBe('Product not found.');
  });

  it('throws when an order write fails', async () => {
    const { client } = fakeClient({
      products: [
        { data: rows, error: null },
        { data: null, error: { code: '23514' } },
      ],
    });
    await expect(moveProduct(client, 'a@x', P(2), 'down')).rejects.toEqual({ code: '23514' });
  });
});
