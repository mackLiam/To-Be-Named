import { shouldUseFake } from './data';
import { lookaheadRange, splitLookahead } from './pagination';
import { WAITLIST_INTERESTS, type WaitlistInterest } from './waitlist';

/**
 * Admin waitlist read. Emails are personal data: callers must already hold
 * requireAdmin(), and a live read writes one audit_log row. Never log emails.
 */

export interface WaitlistRow {
  id: number;
  email: string;
  interest: WaitlistInterest;
  created_at: string;
}

export interface WaitlistView {
  counts: Record<WaitlistInterest, number>;
  rows: WaitlistRow[];
  hasNext: boolean;
}

export function parseInterest(value: string | undefined | null): WaitlistInterest | undefined {
  return (WAITLIST_INTERESTS as readonly string[]).includes(value ?? '')
    ? (value as WaitlistInterest)
    : undefined;
}

export const FAKE_WAITLIST: WaitlistRow[] = [
  {
    id: 4,
    email: 'fake-four@example.com',
    interest: 'junior_max',
    created_at: '2026-09-20T09:00:00Z',
  },
  { id: 3, email: 'fake-three@example.com', interest: 'pro', created_at: '2026-09-18T12:30:00Z' },
  { id: 2, email: 'fake-two@example.com', interest: 'launch', created_at: '2026-09-15T08:15:00Z' },
  { id: 1, email: 'fake-one@example.com', interest: 'launch', created_at: '2026-09-10T17:45:00Z' },
];

export async function listWaitlist(opts: {
  /** audit_log.actor for the page-view row (live mode only). */
  actor: string;
  interest?: WaitlistInterest;
  page: number;
  pageSize: number;
}): Promise<WaitlistView> {
  if (shouldUseFake()) {
    const counts = { launch: 0, pro: 0, junior_max: 0 };
    for (const row of FAKE_WAITLIST) counts[row.interest] += 1;
    const filtered = opts.interest
      ? FAKE_WAITLIST.filter((r) => r.interest === opts.interest)
      : FAKE_WAITLIST;
    const start = (opts.page - 1) * opts.pageSize;
    return {
      counts,
      ...splitLookahead(filtered.slice(start, start + opts.pageSize + 1), opts.pageSize),
    };
  }

  const { createServiceRoleClient } = await import('./supabase-admin');
  const client = createServiceRoleClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  let list = client.from('waitlist').select('id, email, interest, created_at');
  if (opts.interest) {
    list = list.eq('interest', opts.interest);
  }
  const [listed, ...counted] = await Promise.all([
    list.order('created_at', { ascending: false }).range(from, to),
    ...WAITLIST_INTERESTS.map((interest) =>
      client.from('waitlist').select('id', { count: 'exact', head: true }).eq('interest', interest),
    ),
  ]);
  if (listed.error) throw listed.error;
  for (const { error } of counted) {
    if (error) throw error;
  }
  const counts = { launch: 0, pro: 0, junior_max: 0 };
  WAITLIST_INTERESTS.forEach((interest, i) => {
    counts[interest] = counted[i]!.count ?? 0;
  });

  // One audit row per live page view; failure to record means no data is shown.
  const audit = await client.from('audit_log').insert({
    actor: opts.actor,
    action: 'waitlist.view',
    subject_table: null,
    detail: { interest: opts.interest ?? null, page: opts.page },
  });
  if (audit.error) throw audit.error;

  return { counts, ...splitLookahead((listed.data ?? []) as WaitlistRow[], opts.pageSize) };
}
