import { isFakeMode, hasServiceRoleConfig } from './env';
import { fakeJobs, fakeOrders, fakeTriage } from './fake';
import { lookaheadRange, splitLookahead } from './pagination';
import type { GateResult, JobError, JobRow, OrderRow, TriageData } from './types';

/**
 * Admin data access. Every read is bounded (page size clamped by the caller,
 * one-row lookahead for hasNext) and goes through the SERVICE ROLE client,
 * because the admin-only tables (pipeline_jobs, audit_log) have no RLS
 * policies and are unreadable by an ordinary authenticated session.
 *
 * The service client is imported dynamically inside the live branch only, so
 * this module (and its fake-data path) stays free of the 'server-only' import
 * and can be unit tested in a plain node environment.
 */

export const JOB_STATES = ['pending', 'running', 'succeeded', 'failed', 'dead_letter'] as const;
export type JobState = (typeof JOB_STATES)[number];

export function isValidJobState(value: string | undefined | null): value is JobState {
  return value != null && (JOB_STATES as readonly string[]).includes(value);
}

/** Live queries need the service role; without it, fall back to fake data. */
function shouldUseFake(): boolean {
  return isFakeMode() || !hasServiceRoleConfig();
}

async function serviceClient() {
  const { createServiceRoleClient } = await import('./supabase-admin');
  return createServiceRoleClient();
}

const JOB_COLUMNS =
  'id, order_id, scan_id, step, status, attempts, max_attempts, error, created_at, updated_at, finished_at';

export interface ListResult<T> {
  rows: T[];
  hasNext: boolean;
}

export async function listPipelineJobs(opts: {
  state?: string;
  page: number;
  pageSize: number;
}): Promise<ListResult<JobRow>> {
  if (shouldUseFake()) {
    const filtered = isValidJobState(opts.state)
      ? fakeJobs.filter((row) => row.status === opts.state)
      : fakeJobs;
    const start = (opts.page - 1) * opts.pageSize;
    const window = filtered.slice(start, start + opts.pageSize + 1);
    return splitLookahead(window, opts.pageSize);
  }

  const client = await serviceClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  let query = client.from('pipeline_jobs').select(JOB_COLUMNS);
  if (isValidJobState(opts.state)) {
    query = query.eq('status', opts.state);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return splitLookahead((data ?? []) as JobRow[], opts.pageSize);
}

const ORDER_COLUMNS =
  'id, status, amount_cents, currency, product_id, scan_id_left, scan_id_right, created_at';

export async function listOrders(opts: {
  page: number;
  pageSize: number;
}): Promise<ListResult<OrderRow>> {
  if (shouldUseFake()) {
    const start = (opts.page - 1) * opts.pageSize;
    const window = fakeOrders.slice(start, start + opts.pageSize + 1);
    return splitLookahead(window, opts.pageSize);
  }

  const client = await serviceClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  const { data, error } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) {
    throw error;
  }
  return splitLookahead((data ?? []) as OrderRow[], opts.pageSize);
}

function gatesFromError(error: JobError | null): GateResult[] {
  return Array.isArray(error?.gates) ? error!.gates : [];
}

export async function getTriage(jobId: string): Promise<TriageData | null> {
  if (shouldUseFake()) {
    return fakeTriage(jobId);
  }

  const client = await serviceClient();
  const { data: job, error: jobError } = await client
    .from('pipeline_jobs')
    .select('id, scan_id, step, status, error')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) {
    throw jobError;
  }
  if (!job) {
    return null;
  }

  // Latest measurement payload for this scan, if extraction ran at all.
  const { data: measurement, error: measurementError } = await client
    .from('measurements')
    .select('values, created_at')
    .eq('scan_id', job.scan_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (measurementError) {
    throw measurementError;
  }

  const typedError = (job.error ?? null) as JobError | null;
  return {
    job: {
      id: job.id,
      scan_id: job.scan_id,
      step: job.step,
      status: job.status,
      error: typedError,
    },
    gates: gatesFromError(typedError),
    values: (measurement?.values ?? null) as TriageData['values'],
  };
}
