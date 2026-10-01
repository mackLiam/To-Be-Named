import type { SupabaseClient } from '@supabase/supabase-js';

import { shouldUseFake } from './data';
import { lookaheadRange, splitLookahead } from './pagination';

/**
 * Admin operations: dead-letter retry and the audit log reader. Reads go
 * through the service role client (audit_log has no RLS policies); the live
 * client is imported dynamically so the fake path stays testable in node.
 */

export type OpsResult = { error: string | null };

const NOT_RETRIABLE =
  'Only a dead-lettered job can be retried, and not one whose scan was deleted or whose order was cancelled.';
const ALREADY_ACTIVE = 'Another job for this scan is already active.';

/** The RPC writes its own audit row; do not add a second one here. */
export async function retryPipelineJob(
  client: SupabaseClient,
  actor: string,
  id: string,
): Promise<OpsResult> {
  const { error } = await client.rpc('retry_pipeline_job', { p_id: id, p_actor: actor });
  if (!error) {
    return { error: null };
  }
  if (error.code === '23514') {
    return { error: NOT_RETRIABLE };
  }
  if (error.code === '23505') {
    return { error: ALREADY_ACTIVE };
  }
  throw error;
}

export const AUDIT_SUBJECT_TABLES = ['orders', 'products', 'pipeline_jobs', 'scans'] as const;
export type AuditSubjectTable = (typeof AUDIT_SUBJECT_TABLES)[number];

export function isAuditSubjectTable(value: string | undefined | null): value is AuditSubjectTable {
  return value != null && (AUDIT_SUBJECT_TABLES as readonly string[]).includes(value);
}

export interface AuditLogRow {
  id: number;
  actor: string;
  action: string;
  subject_table: string | null;
  subject_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export const FAKE_AUDIT_ROWS: AuditLogRow[] = [
  {
    id: 4,
    actor: 'admin@example.test',
    action: 'pipeline_job.retry',
    subject_table: 'pipeline_jobs',
    subject_id: '00000000-0000-4000-8000-0000000000a1',
    detail: { step: 'measure' },
    created_at: '2026-09-29T10:15:00Z',
  },
  {
    id: 3,
    actor: 'admin@example.test',
    action: 'order.ship',
    subject_table: 'orders',
    subject_id: '00000000-0000-4000-8000-0000000000b1',
    detail: { tracking_carrier: 'ups' },
    created_at: '2026-09-29T09:00:00Z',
  },
  {
    id: 2,
    actor: 'admin@example.test',
    action: 'product.update',
    subject_table: 'products',
    subject_id: '00000000-0000-4000-8000-0000000000c1',
    detail: null,
    created_at: '2026-09-28T16:30:00Z',
  },
  {
    id: 1,
    actor: 'system',
    action: 'scan.delete',
    subject_table: 'scans',
    subject_id: '00000000-0000-4000-8000-0000000000d1',
    detail: { reason: 'retention' },
    created_at: '2026-09-28T03:00:00Z',
  },
];

export async function listAuditLog(opts: {
  table?: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: AuditLogRow[]; hasNext: boolean }> {
  const table = isAuditSubjectTable(opts.table) ? opts.table : undefined;

  if (shouldUseFake()) {
    const filtered = table
      ? FAKE_AUDIT_ROWS.filter((row) => row.subject_table === table)
      : FAKE_AUDIT_ROWS;
    const start = (opts.page - 1) * opts.pageSize;
    return splitLookahead(filtered.slice(start, start + opts.pageSize + 1), opts.pageSize);
  }

  const { createServiceRoleClient } = await import('./supabase-admin');
  const client = createServiceRoleClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  let query = client
    .from('audit_log')
    .select('id, actor, action, subject_table, subject_id, detail, created_at');
  if (table) {
    query = query.eq('subject_table', table);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);
  if (error) {
    throw error;
  }
  return splitLookahead((data ?? []) as AuditLogRow[], opts.pageSize);
}

/** Compact, truncated JSON for a table cell. */
export function compactDetail(detail: Record<string, unknown> | null, maxLen = 80): string {
  if (detail == null) {
    return '-';
  }
  const text = JSON.stringify(detail);
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

/** Admin route for a subject, or null when it has no detail page. */
export function subjectHref(table: string | null, id: string | null): string | null {
  if (!id) {
    return null;
  }
  if (table === 'orders') {
    return `/admin/orders/${id}`;
  }
  if (table === 'pipeline_jobs') {
    return `/admin/jobs/${id}`;
  }
  return null;
}
