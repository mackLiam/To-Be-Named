import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from './ids';
import type { ParseResult } from './shop';

/**
 * Internal admin notes on an order (migration 0026). Plain text, append-only,
 * never shown to the customer. add_order_note writes the audit row itself.
 */

/** order_notes_body_length (0026). */
export const MAX_NOTE_LENGTH = 2000;

export interface NoteInput {
  orderId: string;
  body: string;
  /** Rendered into the form; a double submit carries the same one. */
  requestId: string;
}

export function parseNoteForm(form: Record<string, string | undefined>): ParseResult<NoteInput> {
  const errors: string[] = [];
  const orderId = (form.id ?? '').trim();
  const requestId = (form.request_id ?? '').trim();
  const body = (form.body ?? '').trim();
  if (!isUuid(orderId)) {
    errors.push('Unknown order.');
  }
  if (!isUuid(requestId)) {
    errors.push('The note form expired. Reload the page and try again.');
  }
  if (!body) {
    errors.push('Write the note before saving it.');
  } else if (body.length > MAX_NOTE_LENGTH) {
    errors.push(`A note is at most ${MAX_NOTE_LENGTH} characters.`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { orderId: orderId.toLowerCase(), body, requestId: requestId.toLowerCase() },
  };
}

export async function addOrderNote(
  client: SupabaseClient,
  actor: string,
  input: NoteInput,
): Promise<{ error: string | null }> {
  const { error } = await client.rpc('add_order_note', {
    p_order_id: input.orderId,
    p_body: input.body,
    p_request_id: input.requestId,
    p_actor: actor,
  });
  if (!error) {
    return { error: null };
  }
  if (error.code === 'P0002') {
    return { error: 'Order not found.' };
  }
  if (error.code === '22023') {
    return { error: `Note refused: ${error.message}` };
  }
  throw error;
}
