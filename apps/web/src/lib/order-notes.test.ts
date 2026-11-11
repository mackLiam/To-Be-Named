import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { MAX_NOTE_LENGTH, addOrderNote, parseNoteForm } from './order-notes';

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const REQ = '00000000-0000-4000-8000-0000000000f1';

describe('parseNoteForm', () => {
  it('trims and accepts up to 2000 characters', () => {
    expect(parseNoteForm({ id: ORDER, request_id: REQ, body: '  Called them.  ' })).toEqual({
      ok: true,
      value: { orderId: ORDER, body: 'Called them.', requestId: REQ },
    });
    expect(MAX_NOTE_LENGTH).toBe(2000);
    expect(parseNoteForm({ id: ORDER, request_id: REQ, body: 'x'.repeat(2000) }).ok).toBe(true);
  });

  it('rejects empty, too long, and a missing order or request id', () => {
    expect(parseNoteForm({ id: ORDER, request_id: REQ, body: '   ' })).toEqual({
      ok: false,
      errors: ['Write the note before saving it.'],
    });
    expect(parseNoteForm({ id: ORDER, request_id: REQ, body: 'x'.repeat(2001) })).toEqual({
      ok: false,
      errors: ['A note is at most 2000 characters.'],
    });
    expect(parseNoteForm({ id: 'x', body: 'hi' })).toEqual({
      ok: false,
      errors: ['Unknown order.', 'The note form expired. Reload the page and try again.'],
    });
  });
});

describe('addOrderNote', () => {
  const input = { orderId: ORDER, body: 'Called them.', requestId: REQ };

  it('calls the RPC with the request id that makes a resubmit idempotent', async () => {
    const rpc = vi.fn(async () => ({ data: 7, error: null }));
    expect(await addOrderNote({ rpc } as unknown as SupabaseClient, 'admin@x', input)).toEqual({
      error: null,
    });
    expect(rpc).toHaveBeenCalledWith('add_order_note', {
      p_order_id: ORDER,
      p_body: 'Called them.',
      p_request_id: REQ,
      p_actor: 'admin@x',
    });
  });

  it('maps refusals and throws the rest', async () => {
    const client = (error: { code: string; message: string }) =>
      ({ rpc: async () => ({ data: null, error }) }) as unknown as SupabaseClient;
    expect(await addOrderNote(client({ code: 'P0002', message: 'x' }), 'a', input)).toEqual({
      error: 'Order not found.',
    });
    expect(
      await addOrderNote(
        client({ code: '22023', message: 'a note is 1 to 2000 characters' }),
        'a',
        input,
      ),
    ).toEqual({ error: 'Note refused: a note is 1 to 2000 characters' });
    await expect(
      addOrderNote(client({ code: '42501', message: 'denied' }), 'a', input),
    ).rejects.toMatchObject({
      message: 'denied',
    });
  });
});
