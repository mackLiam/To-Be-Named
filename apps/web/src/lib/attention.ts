import type { OrderStatus } from '@forms/shared';

import { applyNeedsRefund, shouldUseFake } from './data';

/**
 * Ops "needs attention" counts for the admin landing page. Head-only count
 * queries through the service-role client: nothing but a number leaves the DB.
 */

export type AttentionKey = 'paid_not_started' | 'dead_letter' | 'needs_refund';
export type AttentionCounts = Record<AttentionKey, number>;
export interface AttentionItem {
  key: AttentionKey;
  label: string;
  count: number;
  href: string;
}

const ITEMS: { key: AttentionKey; label: string; href: string }[] = [
  { key: 'paid_not_started', label: 'Paid orders not started', href: '/admin/orders?status=paid' },
  { key: 'dead_letter', label: 'Dead-lettered jobs', href: '/admin?status=dead_letter' },
  { key: 'needs_refund', label: 'Payments to refund', href: '/admin/orders?needs_refund=1' },
];

export const FAKE_ATTENTION_COUNTS: AttentionCounts = {
  paid_not_started: 2,
  dead_letter: 1,
  needs_refund: 1,
};

/** Only non-zero items; an empty result means the quiet "nothing" line. */
export function buildAttentionItems(counts: AttentionCounts): AttentionItem[] {
  return ITEMS.map((item) => ({ ...item, count: counts[item.key] })).filter((i) => i.count > 0);
}

export async function getAttentionCounts(): Promise<AttentionCounts> {
  if (shouldUseFake()) {
    return FAKE_ATTENTION_COUNTS;
  }
  const { createServiceRoleClient } = await import('./supabase-admin');
  const client = createServiceRoleClient();
  const head = { count: 'exact', head: true } as const;

  const [paid, dead, refund] = await Promise.all([
    client
      .from('orders')
      .select('id', head)
      .eq('status', 'paid' satisfies OrderStatus),
    client.from('pipeline_jobs').select('id', head).eq('status', 'dead_letter'),
    applyNeedsRefund(client.from('orders').select('id', head)),
  ]);
  for (const { error } of [paid, dead, refund]) {
    if (error) {
      throw error;
    }
  }
  return {
    paid_not_started: paid.count ?? 0,
    dead_letter: dead.count ?? 0,
    needs_refund: refund.count ?? 0,
  };
}
