import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { hasDeletionRequest } from './account-deletion';

function client(result: { count: number | null; error: { message: string } | null }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq']) {
    builder[op] = (...args: unknown[]) => {
      calls.push([op, args]);
      return builder;
    };
  }
  builder.then = (resolve: (r: typeof result) => void) => resolve(result);
  const from = (table: string) => {
    calls.push(['from', [table]]);
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe('hasDeletionRequest', () => {
  it('counts the requests for exactly that user, without reading rows', async () => {
    const { client: c, calls } = client({ count: 1, error: null });
    expect(await hasDeletionRequest(c, 'u1')).toBe(true);
    expect(calls).toEqual([
      ['from', ['account_deletion_requests']],
      ['select', ['user_id', { count: 'exact', head: true }]],
      ['eq', ['user_id', 'u1']],
    ]);
  });

  it('is false with no request, and throws a read error', async () => {
    expect(await hasDeletionRequest(client({ count: 0, error: null }).client, 'u1')).toBe(false);
    expect(await hasDeletionRequest(client({ count: null, error: null }).client, 'u1')).toBe(false);
    await expect(
      hasDeletionRequest(client({ count: null, error: { message: 'down' } }).client, 'u1'),
    ).rejects.toMatchObject({ message: 'down' });
  });
});
