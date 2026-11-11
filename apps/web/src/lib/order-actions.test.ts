import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { EmailDeps } from './email';
import {
  READ_ONLY,
  addOrderNoteAction,
  afterStatusChange,
  refundOrderAction,
  remakeOrderAction,
  type AdminWriter,
} from './order-actions';
import type { RefundStripe } from './refund';

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const REMAKE = '00000000-0000-4000-8000-0000000000a8';
const REQ = '00000000-0000-4000-8000-0000000000f1';

type Result = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * Supabase stand-in: rpc results queued per function, table reads queued per
 * table, and every insert recorded (audit rows).
 */
function fakeClient(opts: {
  rpc?: Record<string, Result[]>;
  tables?: Record<string, Result[]>;
  email?: string | null;
}) {
  const rpc = vi.fn(async (fn: string) => opts.rpc?.[fn]?.shift() ?? { data: null, error: null });
  const inserts: [string, unknown][] = [];
  const client = {
    rpc,
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'update', 'eq', 'order', 'limit', 'maybeSingle']) {
        builder[op] = () => builder;
      }
      builder.insert = (row: unknown) => {
        inserts.push([table, row]);
        return builder;
      };
      builder.then = (resolve: (r: Result) => void) =>
        resolve(opts.tables?.[table]?.shift() ?? { data: null, error: null });
      return builder;
    },
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: { user: { email: opts.email === undefined ? 'c@example.test' : opts.email } },
          error: null,
        })),
      },
    },
  };
  return { client: client as unknown as SupabaseClient, rpc, inserts };
}

function emailDeps(): EmailDeps {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never,
    apiKey: 'rk_secret',
    from: 'FORMS <orders@example.test>',
  };
}

const writer = (client: SupabaseClient): AdminWriter => ({ client, actor: 'admin@x' });

/** requireAdmin for a non-admin: notFound() throws. */
const denied = () =>
  vi.fn(async (): Promise<AdminWriter | null> => {
    throw new Error('NEXT_NOT_FOUND');
  });

const emailAudits = (inserts: [string, unknown][]) =>
  inserts
    .filter(([table]) => table === 'audit_log')
    .map(
      ([, row]) => row as { action: string; subject_id: string; detail: Record<string, unknown> },
    );

describe('admin gate', () => {
  it.each([
    [
      'remake',
      (authorize: () => Promise<AdminWriter | null>) =>
        remakeOrderAction({ authorize, email: emailDeps() }, { id: ORDER, reason: 'print_defect' }),
    ],
    [
      'refund',
      (authorize: () => Promise<AdminWriter | null>) =>
        refundOrderAction(
          { authorize, email: emailDeps(), stripe: () => ({}) as RefundStripe },
          { id: ORDER, mode: 'full' },
        ),
    ],
    [
      'note',
      (authorize: () => Promise<AdminWriter | null>) =>
        addOrderNoteAction(
          { authorize, email: emailDeps() },
          { id: ORDER, body: 'x', request_id: REQ },
        ),
    ],
  ])('a non-admin is refused before anything runs (%s)', async (_label, run) => {
    const authorize = denied();
    await expect(run(authorize)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('the gate runs before the input is parsed', async () => {
    const order: string[] = [];
    const form = new Proxy({} as Record<string, string>, {
      get(_target, key) {
        order.push(`read:${String(key)}`);
        return undefined;
      },
    });
    const authorize = vi.fn(async () => {
      order.push('authorize');
      return null;
    });
    await remakeOrderAction({ authorize, email: emailDeps() }, form);
    expect(order[0]).toBe('authorize');
  });

  it('read-only mode writes nothing', async () => {
    const stripe = vi.fn();
    const out = await refundOrderAction(
      { authorize: async () => null, email: emailDeps(), stripe },
      { id: ORDER, mode: 'partial', amount: '5' },
    );
    expect(out).toEqual({ path: `/admin/orders/${ORDER}`, error: READ_ONLY, notice: null });
    expect(stripe).not.toHaveBeenCalled();
    expect(
      (
        await remakeOrderAction(
          { authorize: async () => null, email: emailDeps() },
          { id: ORDER, reason: 'print_defect' },
        )
      ).error,
    ).toBe(READ_ONLY);
    expect(
      (
        await addOrderNoteAction(
          { authorize: async () => null, email: emailDeps() },
          { id: ORDER, body: 'x', request_id: REQ },
        )
      ).error,
    ).toBe(READ_ONLY);
  });
});

describe('remakeOrderAction', () => {
  const remakeOrderRow: Result = {
    data: {
      id: REMAKE,
      user_id: 'u1',
      paid_at: '2026-07-01',
      remake_of: ORDER,
      products: { name: 'Pro Guard' },
    },
    error: null,
  };

  it('creates the remake, emails the customer, audits the email, and opens the remake', async () => {
    const { client, rpc, inserts } = fakeClient({
      rpc: {
        create_order_remake: [{ data: [{ remake_id: REMAKE, outcome: 'created' }], error: null }],
      },
      tables: { orders: [remakeOrderRow] },
    });
    const email = emailDeps();
    const out = await remakeOrderAction(
      { authorize: async () => writer(client), email },
      { id: ORDER, reason: 'damaged_in_transit', legs: 'both' },
    );
    expect(out).toEqual({
      path: `/admin/orders/${REMAKE}`,
      error: null,
      notice: 'Remake created. Its CAD jobs are queued from the original scans.',
    });
    expect(rpc).toHaveBeenCalledWith('create_order_remake', {
      p_order_id: ORDER,
      p_reason: 'damaged_in_transit',
      p_note: null,
      p_legs: 'both',
      p_actor: 'admin@x',
    });
    expect(email.fetch).toHaveBeenCalledTimes(1);
    expect(emailAudits(inserts)).toEqual([
      {
        actor: 'admin@x',
        action: 'order.email',
        subject_table: 'orders',
        subject_id: REMAKE,
        detail: { template: 'remake_started', sent: true, reason: null },
      },
    ]);
  });

  it('a double click lands on the open remake without a second email', async () => {
    const { client, inserts } = fakeClient({
      rpc: {
        create_order_remake: [{ data: [{ remake_id: REMAKE, outcome: 'duplicate' }], error: null }],
      },
    });
    const email = emailDeps();
    const out = await remakeOrderAction(
      { authorize: async () => writer(client), email },
      { id: ORDER, reason: 'print_defect' },
    );
    expect(out.path).toBe(`/admin/orders/${REMAKE}`);
    expect(out.notice).toMatch(/already had an open remake/);
    expect(email.fetch).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('returns refusals and bad input to the original order page', async () => {
    const { client, rpc } = fakeClient({
      rpc: {
        create_order_remake: [
          { data: null, error: { code: '23514', message: 'the customer deleted their account' } },
        ],
      },
    });
    const deps = { authorize: async () => writer(client), email: emailDeps() };
    expect(await remakeOrderAction(deps, { id: ORDER, reason: 'print_defect' })).toEqual({
      path: `/admin/orders/${ORDER}`,
      error: 'Remake refused: the customer deleted their account.',
      notice: null,
    });
    expect(await remakeOrderAction(deps, { id: ORDER, reason: 'other' })).toMatchObject({
      error: 'Describe the reason when it is Other.',
    });
    expect(await remakeOrderAction(deps, { id: 'bad', reason: 'print_defect' })).toMatchObject({
      path: '/admin/orders',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('refundOrderAction', () => {
  const orderRow: Result = {
    data: {
      status: 'shipped',
      stripe_payment_intent: 'pi_123',
      refunded_at: null,
      amount_cents: 17800,
      stripe_refunded_cents: null,
      products: { currency: 'usd' },
    },
    error: null,
  };
  const emailOrderRow: Result = {
    data: {
      id: ORDER,
      user_id: 'u1',
      paid_at: '2026-07-01',
      remake_of: null,
      products: { name: 'Pro Guard' },
    },
    error: null,
  };

  function stripeMock(fail?: Error) {
    const create = vi.fn(async (params: { amount?: number }) => {
      if (fail) {
        throw fail;
      }
      return { id: 're_9', status: 'succeeded', amount: params.amount ?? 17800 };
    });
    const list = vi.fn(async () => ({ data: [], has_more: false }));
    return { stripe: { refunds: { create, list } } as RefundStripe, create };
  }

  it('issues a partial refund in major units, emails once, and audits the email', async () => {
    const { client, rpc, inserts } = fakeClient({
      tables: { orders: [orderRow, emailOrderRow], order_refunds: [{ data: [], error: null }] },
      rpc: { record_order_refund: [{ data: 'recorded', error: null }] },
    });
    const { stripe, create } = stripeMock();
    const email = emailDeps();
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email, stripe: () => stripe },
      { id: ORDER, mode: 'partial', amount: '12.50' },
    );
    expect(out).toEqual({ path: `/admin/orders/${ORDER}`, error: null, notice: 'Refund issued.' });
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123', amount: 1250 },
      { idempotencyKey: `refund-${ORDER}-1` },
    );
    expect(rpc).toHaveBeenCalledWith(
      'record_order_refund',
      expect.objectContaining({ p_amount_cents: 1250 }),
    );
    const [, init] = (email.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    const sent = JSON.parse(init.body);
    expect(sent.text).toContain('partial refund of $12.50');
    expect(emailAudits(inserts).map((r) => r.detail)).toEqual([
      { template: 'refund_issued', sent: true, reason: null },
    ]);
  });

  it('refuses an over-refund without calling Stripe', async () => {
    const { client } = fakeClient({
      tables: { orders: [orderRow], order_refunds: [{ data: [], error: null }] },
    });
    const { stripe, create } = stripeMock();
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email: emailDeps(), stripe: () => stripe },
      { id: ORDER, mode: 'partial', amount: '178.01' },
    );
    expect(out.error).toBe('The refund must be more than 0 and at most the amount left to refund.');
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a Stripe error and sends no email', async () => {
    const { client, inserts } = fakeClient({
      tables: { orders: [orderRow], order_refunds: [{ data: [], error: null }] },
    });
    const { stripe } = stripeMock(new Error('Your card was declined.'));
    const email = emailDeps();
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email, stripe: () => stripe },
      { id: ORDER, mode: 'full' },
    );
    expect(out.error).toBe(
      'Stripe did not refund the payment. The Stripe dashboard shows why; nothing was recorded.',
    );
    expect(email.fetch).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('a repeat of a recorded refund sends no second email', async () => {
    const { client } = fakeClient({
      tables: { orders: [orderRow], order_refunds: [{ data: [], error: null }] },
      rpc: { record_order_refund: [{ data: 'duplicate', error: null }] },
    });
    const email = emailDeps();
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email, stripe: () => stripeMock().stripe },
      { id: ORDER, mode: 'full' },
    );
    expect(out.notice).toBe('This refund was already issued and recorded.');
    expect(email.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: ORDER, mode: 'partial', amount: '' }, 'Enter the refund amount, for example 12.50.'],
    [{ id: ORDER, mode: 'partial', amount: '0' }, 'Enter the refund amount, for example 12.50.'],
    [{ id: ORDER, mode: 'partial', amount: '-3' }, 'Enter the refund amount, for example 12.50.'],
    [{ id: ORDER, mode: 'half' }, 'Choose a full or a partial refund.'],
    [{ id: ORDER }, 'Choose a full or a partial refund.'],
    [{ id: ORDER, amount: '12.50' }, 'Choose a full or a partial refund.'],
    [{ id: ORDER, mode: '' }, 'Choose a full or a partial refund.'],
    [{ id: ORDER, mode: 'FULL' }, 'Choose a full or a partial refund.'],
    [{ id: ORDER, mode: ' full' }, 'Choose a full or a partial refund.'],
    [{ id: 'nope', mode: 'full' }, 'Unknown order.'],
  ])('rejects bad input %o', async (form, message) => {
    const stripe = vi.fn();
    const { client } = fakeClient({});
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email: emailDeps(), stripe },
      form,
    );
    expect(out.error).toBe(message);
    expect(stripe).not.toHaveBeenCalled();
  });

  it('says so when Stripe is not configured', async () => {
    const { client } = fakeClient({});
    const out = await refundOrderAction(
      { authorize: async () => writer(client), email: emailDeps(), stripe: () => null },
      { id: ORDER, mode: 'full' },
    );
    expect(out.error).toBe('Refunds are unavailable: STRIPE_SECRET_KEY is not configured.');
  });
});

describe('addOrderNoteAction', () => {
  it('adds the note with its request id', async () => {
    const { client, rpc } = fakeClient({ rpc: { add_order_note: [{ data: 3, error: null }] } });
    const out = await addOrderNoteAction(
      { authorize: async () => writer(client), email: emailDeps() },
      { id: ORDER, body: ' Spoke to parent. ', request_id: REQ },
    );
    expect(out).toEqual({ path: `/admin/orders/${ORDER}`, error: null, notice: 'Note added.' });
    expect(rpc).toHaveBeenCalledWith('add_order_note', {
      p_order_id: ORDER,
      p_body: 'Spoke to parent.',
      p_request_id: REQ,
      p_actor: 'admin@x',
    });
  });

  it('refuses an over-long note before calling the database', async () => {
    const { client, rpc } = fakeClient({});
    const out = await addOrderNoteAction(
      { authorize: async () => writer(client), email: emailDeps() },
      { id: ORDER, body: 'x'.repeat(2001), request_id: REQ },
    );
    expect(out.error).toBe('A note is at most 2000 characters.');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('afterStatusChange', () => {
  const paidOrder: Result = {
    data: {
      id: ORDER,
      user_id: 'u1',
      paid_at: '2026-07-01',
      remake_of: null,
      products: { name: 'Pro Guard' },
    },
    error: null,
  };

  it('emails and audits a cancellation of a paid order', async () => {
    const { client, inserts } = fakeClient({ tables: { orders: [paidOrder] } });
    const email = emailDeps();
    await afterStatusChange(writer(client), ORDER, 'cancelled', email);
    expect(email.fetch).toHaveBeenCalledTimes(1);
    expect(emailAudits(inserts).map((r) => r.detail)).toEqual([
      { template: 'order_cancelled', sent: true, reason: null },
    ]);
  });

  it('stays silent for an abandoned checkout', async () => {
    const { client, inserts } = fakeClient({
      tables: { orders: [{ data: { ...(paidOrder.data as object), paid_at: null }, error: null }] },
    });
    const email = emailDeps();
    await afterStatusChange(writer(client), ORDER, 'cancelled', email);
    expect(email.fetch).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('audits the shipped email, sent or not, and ignores other moves', async () => {
    const { client, inserts } = fakeClient({
      tables: {
        orders: [
          {
            data: {
              id: ORDER,
              user_id: 'u1',
              tracking_carrier: 'UPS',
              tracking_number: '1Z',
              products: { name: 'Pro Guard' },
            },
            error: null,
          },
        ],
      },
    });
    await afterStatusChange(writer(client), ORDER, 'shipped', {
      ...emailDeps(),
      apiKey: undefined,
    });
    expect(emailAudits(inserts).map((r) => r.detail)).toEqual([
      { template: 'order_shipped', sent: false, reason: 'not_configured' },
    ]);
    const other = fakeClient({});
    await afterStatusChange(writer(other.client), ORDER, 'in_production', emailDeps());
    expect(other.inserts).toEqual([]);
  });

  it('a failing audit insert never throws', async () => {
    const { client } = fakeClient({ tables: { orders: [paidOrder], audit_log: [] } });
    (client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table === 'audit_log') {
        throw new Error('audit down');
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => paidOrder }) }),
      };
    };
    await expect(
      afterStatusChange(writer(client), ORDER, 'cancelled', emailDeps()),
    ).resolves.toBeUndefined();
  });
});
