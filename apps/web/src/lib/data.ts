import { isFakeMode, hasServiceRoleConfig } from './env';
import { fakeJobs, fakeOrderDetail, fakeOrders, fakeProducts, fakeTriage } from './fake';
import { lookaheadRange, splitLookahead } from './pagination';
import { isOrderStatus, isUuid } from './shop';
import type {
  AuditRow,
  GateResult,
  JobError,
  JobRow,
  OrderDetail,
  OrderRow,
  ProductRow,
  TriageData,
} from './types';

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
export function shouldUseFake(): boolean {
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

// orders carries no name or currency; both come from the product join.
const ORDER_COLUMNS =
  'id, user_id, status, amount_cents, product_id, scan_id_left, scan_id_right, ' +
  'tracking_carrier, tracking_number, created_at, updated_at, products(name, currency)';

type OrderQueryRow = Omit<OrderRow, 'product_name' | 'currency'> & {
  products: { name: string; currency: string } | null;
};

function flattenOrder({ products, ...row }: OrderQueryRow): OrderRow {
  return { ...row, product_name: products?.name ?? null, currency: products?.currency ?? null };
}

export async function listOrders(opts: {
  status?: string;
  page: number;
  pageSize: number;
}): Promise<ListResult<OrderRow>> {
  if (shouldUseFake()) {
    const filtered = isOrderStatus(opts.status)
      ? fakeOrders.filter((row) => row.status === opts.status)
      : fakeOrders;
    const start = (opts.page - 1) * opts.pageSize;
    return splitLookahead(filtered.slice(start, start + opts.pageSize + 1), opts.pageSize);
  }

  const client = await serviceClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  let query = client.from('orders').select(ORDER_COLUMNS);
  if (isOrderStatus(opts.status)) {
    query = query.eq('status', opts.status);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  const rows = ((data ?? []) as unknown as OrderQueryRow[]).map(flattenOrder);
  return splitLookahead(rows, opts.pageSize);
}

/** Order history shown on the detail page; bounded, newest first. */
const HISTORY_LIMIT = 50;

export async function getOrderDetail(id: string): Promise<OrderDetail | null> {
  if (!isUuid(id)) {
    return null;
  }
  if (shouldUseFake()) {
    return fakeOrderDetail(id);
  }

  const client = await serviceClient();
  const { data, error } = await client
    .from('orders')
    .select(`${ORDER_COLUMNS}, address, stripe_payment_intent, paid_at, refunded_at`)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  const { address, stripe_payment_intent, paid_at, refunded_at, ...rest } =
    data as unknown as OrderQueryRow &
      Pick<OrderDetail, 'address' | 'stripe_payment_intent' | 'paid_at' | 'refunded_at'>;
  const order = flattenOrder(rest);

  const [jobs, history, user] = await Promise.all([
    client
      .from('pipeline_jobs')
      .select('id, scan_id, step, status')
      .eq('order_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    client
      .from('audit_log')
      .select('id, actor, action, detail, created_at')
      .eq('subject_table', 'orders')
      .eq('subject_id', id)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
    client.auth.admin.getUserById(order.user_id),
  ]);
  if (jobs.error) {
    throw jobs.error;
  }
  if (history.error) {
    throw history.error;
  }

  return {
    ...order,
    address,
    stripe_payment_intent,
    paid_at,
    refunded_at,
    // A deleted auth user cascades the order away, so a miss here is rare;
    // render the order anyway rather than fail the page on a lookup.
    customer_email: user.data.user?.email ?? null,
    jobs: (jobs.data ?? []) as OrderDetail['jobs'],
    history: (history.data ?? []) as AuditRow[],
  };
}

const PRODUCT_COLUMNS =
  'id, name, slug, description, base_price_cents, currency, image_url, active, cad_model, updated_at';

// ponytail: the catalog is a handful of guard models; paginate if it passes this.
export const PRODUCT_LIST_LIMIT = 200;

export async function listProducts(): Promise<ProductRow[]> {
  if (shouldUseFake()) {
    return fakeProducts;
  }
  const client = await serviceClient();
  const { data, error } = await client
    .from('products')
    .select(PRODUCT_COLUMNS)
    .order('active', { ascending: false })
    .order('name')
    .limit(PRODUCT_LIST_LIMIT);
  if (error) {
    throw error;
  }
  return (data ?? []) as ProductRow[];
}

export async function getProduct(id: string): Promise<ProductRow | null> {
  if (!isUuid(id)) {
    return null;
  }
  if (shouldUseFake()) {
    return fakeProducts.find((row) => row.id === id) ?? null;
  }
  const client = await serviceClient();
  const { data, error } = await client
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return (data as ProductRow | null) ?? null;
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
