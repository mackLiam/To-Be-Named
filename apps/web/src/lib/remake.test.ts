import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  REMAKE_REASONS,
  canRemake,
  createRemake,
  isFitReason,
  parseRemakeForm,
  remakeLegOptions,
  remakeReasonLabel,
  remakeState,
} from './remake';

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const REMAKE = '00000000-0000-4000-8000-0000000000a8';

function rpcClient(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('reasons', () => {
  it('match the 0024 check constraint exactly', () => {
    expect(REMAKE_REASONS).toEqual([
      'fit_too_tight',
      'fit_too_loose',
      'print_defect',
      'damaged_in_transit',
      'wrong_item',
      'other',
    ]);
    expect(remakeReasonLabel('damaged_in_transit')).toBe('Damaged in transit');
    expect(remakeReasonLabel('unknown_thing')).toBe('unknown_thing');
    expect(remakeReasonLabel(null)).toBe('');
  });

  it('flags only the fit reasons', () => {
    expect(isFitReason('fit_too_tight')).toBe(true);
    expect(isFitReason('fit_too_loose')).toBe(true);
    expect(isFitReason('print_defect')).toBe(false);
  });
});

describe('canRemake and remakeState', () => {
  const base = {
    status: 'delivered',
    user_id: 'u1',
    remakes: [] as { id: string; status: string }[],
  };

  it('offers a remake for a shipped or delivered order with a live account', () => {
    expect(canRemake(base)).toBe(true);
    expect(canRemake({ ...base, status: 'shipped' })).toBe(true);
    expect(remakeState(base)).toEqual({ kind: 'offer' });
  });

  it('refuses earlier statuses and deleted accounts', () => {
    for (const status of ['pending_payment', 'paid', 'in_production', 'cancelled']) {
      expect(canRemake({ ...base, status })).toBe(false);
      expect(remakeState({ ...base, status }).kind).toBe('unavailable');
    }
    expect(canRemake({ ...base, user_id: null })).toBe(false);
    expect(remakeState({ ...base, user_id: null })).toEqual({
      kind: 'unavailable',
      reason: 'The customer deleted their account, so no remake.',
    });
  });

  it('points at an open remake instead of offering a second', () => {
    expect(
      remakeState({
        ...base,
        remakes: [
          { id: 'old', status: 'cancelled' },
          { id: REMAKE, status: 'paid' },
        ],
      }),
    ).toEqual({ kind: 'open', remakeId: REMAKE });
    expect(remakeState({ ...base, remakes: [{ id: 'old', status: 'cancelled' }] })).toEqual({
      kind: 'offer',
    });
  });

  it('offers leg choices only on a pair', () => {
    expect(remakeLegOptions({ scan_id_left: 'l', scan_id_right: 'r' })).toEqual([
      'both',
      'left',
      'right',
    ]);
    expect(remakeLegOptions({ scan_id_left: 'l', scan_id_right: null })).toEqual(['both']);
  });
});

describe('parseRemakeForm', () => {
  it('accepts a reason with defaults', () => {
    expect(parseRemakeForm({ id: ORDER.toUpperCase(), reason: 'print_defect' })).toEqual({
      ok: true,
      value: { orderId: ORDER, reason: 'print_defect', note: null, legs: 'both' },
    });
  });

  it('requires a note for other and caps it at 500 characters', () => {
    expect(parseRemakeForm({ id: ORDER, reason: 'other', note: '   ' })).toEqual({
      ok: false,
      errors: ['Describe the reason when it is Other.'],
    });
    expect(parseRemakeForm({ id: ORDER, reason: 'other', note: 'x'.repeat(500) }).ok).toBe(true);
    expect(parseRemakeForm({ id: ORDER, reason: 'other', note: 'x'.repeat(501) })).toEqual({
      ok: false,
      errors: ['The note must be at most 500 characters.'],
    });
  });

  it('rejects an unknown order, reason or legs', () => {
    expect(parseRemakeForm({ id: 'nope', reason: 'too_ugly', legs: 'middle' })).toEqual({
      ok: false,
      errors: ['Unknown order.', 'Choose a reason for the remake.', 'Choose which legs to remake.'],
    });
  });
});

describe('createRemake', () => {
  const input = {
    orderId: ORDER,
    reason: 'fit_too_tight' as const,
    note: null,
    legs: 'left' as const,
  };

  it('calls the RPC with the exact arguments and reports a new remake', async () => {
    const { client, rpc } = rpcClient({
      data: [{ remake_id: REMAKE, outcome: 'created' }],
      error: null,
    });
    expect(await createRemake(client, 'admin@x', input)).toEqual({
      error: null,
      remakeId: REMAKE,
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith('create_order_remake', {
      p_order_id: ORDER,
      p_reason: 'fit_too_tight',
      p_note: null,
      p_legs: 'left',
      p_actor: 'admin@x',
    });
  });

  it('a double click returns the open remake, not a second one', async () => {
    const { client } = rpcClient({
      data: [{ remake_id: REMAKE, outcome: 'duplicate' }],
      error: null,
    });
    expect(await createRemake(client, 'a', input)).toEqual({
      error: null,
      remakeId: REMAKE,
      created: false,
    });
  });

  it.each([
    [{ code: 'P0002', message: 'order x not found' }, 'Order not found.'],
    [
      {
        code: '23514',
        message: 'only a shipped or delivered order can be remade (status is paid)',
      },
      'Remake refused: only a shipped or delivered order can be remade (status is paid)',
    ],
    [
      { code: '23514', message: 'product p has no CAD model' },
      'Remake refused: product p has no CAD model',
    ],
    [
      { code: '22023', message: 'a remake for reason other needs a note' },
      'Remake refused: a remake for reason other needs a note',
    ],
    [
      { code: '23505', message: 'duplicate key' },
      'This order already has an open remake. Reload to see it.',
    ],
  ])('maps %o to a form error', async (error, message) => {
    const { client } = rpcClient({ data: null, error });
    expect(await createRemake(client, 'a', input)).toEqual({ error: message });
  });

  it('throws anything unexpected', async () => {
    const { client } = rpcClient({ data: null, error: { code: '08006', message: 'down' } });
    await expect(createRemake(client, 'a', input)).rejects.toMatchObject({ message: 'down' });
    const empty = rpcClient({ data: [], error: null });
    await expect(createRemake(empty.client, 'a', input)).rejects.toThrow(/no row/);
  });
});
