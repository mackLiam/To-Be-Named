import type { OrderStatus } from '@forms/shared';

import { PRODUCT_LIST_LIMIT, compareShopOrder } from './catalog';
import { isFakeMode, hasServiceRoleConfig } from './env';
import { normalizeCustomerRow } from './customers';
import {
  fakeCustomers,
  fakeJobs,
  fakeOrderDetail,
  fakeOrders,
  fakeProductImages,
  fakeProducts,
  fakeTimeline,
  fakeTriage,
} from './fake';
import { MAX_IMAGES_PER_PRODUCT } from './product-images';
import { MAX_REFUNDS_PER_ORDER } from './refund';
import { lookaheadRange, splitLookahead } from './pagination';
import { isOrderStatus, isUuid, orderReferenceRange } from './shop';
import type {
  CustomerRow,
  GateResult,
  JobError,
  JobRow,
  OrderDetail,
  OrderRow,
  ProductImageRow,
  ProductRow,
  RefundRow,
  RemakeChild,
  TimelinePage,
  TimelineRow,
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
  'tracking_carrier, tracking_number, remake_of, remake_reason, created_at, updated_at, ' +
  'products(name, currency)';

type OrderQueryRow = Omit<OrderRow, 'product_name' | 'currency'> & {
  products: { name: string; currency: string } | null;
};

function flattenOrder({ products, ...row }: OrderQueryRow): OrderRow {
  return { ...row, product_name: products?.name ?? null, currency: products?.currency ?? null };
}

interface OrderFilterChain {
  eq(column: string, value: string): OrderFilterChain;
  not(column: string, operator: string, value: unknown): OrderFilterChain;
  is(column: string, value: null): OrderFilterChain;
}

/**
 * Cancelled orders that still hold a captured payment that was never refunded.
 * Typed loosely on purpose: the supabase builder generics blow the type depth limit.
 */
export function applyNeedsRefund<T>(query: T): T {
  return (query as unknown as OrderFilterChain)
    .eq('status', 'cancelled' satisfies OrderStatus)
    .not('stripe_payment_intent', 'is', null)
    .is('refunded_at', null) as unknown as T;
}

export async function listOrders(opts: {
  status?: string;
  /** Payments to refund; takes precedence over status. */
  needsRefund?: boolean;
  /** Customer-facing order reference (8 hex chars); ignored when malformed. */
  ref?: string;
  /** One customer's orders (auth user id); ignored when not a uuid. */
  userId?: string;
  page: number;
  pageSize: number;
}): Promise<ListResult<OrderRow>> {
  const range = orderReferenceRange(opts.ref);
  const userId = opts.userId && isUuid(opts.userId) ? opts.userId.toLowerCase() : undefined;
  if (shouldUseFake()) {
    // Fake rows carry no payment columns, so "needs refund" approximates to cancelled.
    const status = opts.needsRefund ? 'cancelled' : opts.status;
    const filtered = fakeOrders.filter(
      (row) =>
        (!isOrderStatus(status) || row.status === status) &&
        (!range || (row.id >= range.from && row.id <= range.to)) &&
        (!userId || row.user_id === userId),
    );
    const start = (opts.page - 1) * opts.pageSize;
    return splitLookahead(filtered.slice(start, start + opts.pageSize + 1), opts.pageSize);
  }

  const client = await serviceClient();
  const { from, to } = lookaheadRange(opts.page, opts.pageSize);
  let query = client.from('orders').select(ORDER_COLUMNS);
  if (opts.needsRefund) {
    query = applyNeedsRefund(query);
  } else if (isOrderStatus(opts.status)) {
    query = query.eq('status', opts.status);
  }
  if (range) {
    query = query.gte('id', range.from).lte('id', range.to);
  }
  if (userId) {
    query = query.eq('user_id', userId);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  const rows = ((data ?? []) as unknown as OrderQueryRow[]).map(flattenOrder);
  return splitLookahead(rows, opts.pageSize);
}

const REMAKE_LIST_LIMIT = 20;

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
    .select(
      `${ORDER_COLUMNS}, address, stripe_payment_intent, paid_at, refunded_at, stripe_refunded_cents`,
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  const { address, stripe_payment_intent, paid_at, refunded_at, stripe_refunded_cents, ...rest } =
    data as unknown as OrderQueryRow &
      Pick<
        OrderDetail,
        'address' | 'stripe_payment_intent' | 'paid_at' | 'refunded_at' | 'stripe_refunded_cents'
      >;
  const order = flattenOrder(rest);

  const [jobs, refunds, remakes, customerEmail] = await Promise.all([
    client
      .from('pipeline_jobs')
      .select('id, scan_id, step, status')
      .eq('order_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    client
      .from('order_refunds')
      .select('id, seq, kind, amount_cents, stripe_refund_id, stripe_status, actor, created_at')
      .eq('order_id', id)
      .order('seq')
      .limit(MAX_REFUNDS_PER_ORDER),
    client
      .from('orders')
      .select('id, status, remake_reason, created_at')
      .eq('remake_of', id)
      .order('created_at', { ascending: false })
      .limit(REMAKE_LIST_LIMIT),
    lookupCustomerEmail(client.auth.admin, order.user_id),
  ]);
  for (const result of [jobs, refunds, remakes]) {
    if (result.error) {
      throw result.error;
    }
  }

  return {
    ...order,
    address,
    stripe_payment_intent,
    paid_at,
    refunded_at,
    stripe_refunded_cents,
    customer_email: customerEmail,
    jobs: (jobs.data ?? []) as OrderDetail['jobs'],
    refunds: (refunds.data ?? []) as RefundRow[],
    remakes: (remakes.data ?? []) as RemakeChild[],
  };
}

/**
 * One page of the order timeline (admin_order_timeline, 0026). A failed read
 * comes back as rows: null so the page shows an error state for this section
 * instead of failing the whole order page.
 */
export async function getOrderTimeline(
  id: string,
  page: number,
  pageSize: number,
): Promise<TimelinePage> {
  if (!isUuid(id)) {
    return { rows: [], page, hasNext: false };
  }
  if (shouldUseFake()) {
    const start = (page - 1) * pageSize;
    const { rows, hasNext } = splitLookahead(
      fakeTimeline(id).slice(start, start + pageSize + 1),
      pageSize,
    );
    return { rows, page, hasNext };
  }
  try {
    const client = await serviceClient();
    const { from } = lookaheadRange(page, pageSize);
    const { data, error } = await client.rpc('admin_order_timeline', {
      p_order_id: id,
      p_limit: pageSize + 1,
      p_offset: from,
    });
    if (error) {
      console.error(`order timeline failed: ${error.message}`);
      return { rows: null, page, hasNext: false };
    }
    const { rows, hasNext } = splitLookahead((data ?? []) as TimelineRow[], pageSize);
    return { rows, page, hasNext };
  } catch (err) {
    console.error(`order timeline failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { rows: null, page, hasNext: false };
  }
}

/** Customer search by email (admin_find_customers, 0026). Bounded and paginated. */
export async function searchCustomers(opts: {
  email: string;
  exact: boolean;
  page: number;
  pageSize: number;
}): Promise<ListResult<CustomerRow>> {
  const email = opts.email.trim().toLowerCase();
  if (shouldUseFake()) {
    const filtered = fakeCustomers.filter((row) =>
      opts.exact ? row.email === email : row.email.startsWith(email),
    );
    const start = (opts.page - 1) * opts.pageSize;
    return splitLookahead(filtered.slice(start, start + opts.pageSize + 1), opts.pageSize);
  }
  const client = await serviceClient();
  const { from } = lookaheadRange(opts.page, opts.pageSize);
  const { data, error } = await client.rpc('admin_find_customers', {
    p_email: email,
    p_exact: opts.exact,
    p_limit: opts.pageSize + 1,
    p_offset: from,
  });
  if (error) {
    throw error;
  }
  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeCustomerRow);
  return splitLookahead(rows, opts.pageSize);
}

/**
 * The customer's email for the order page. Orders outlive accounts (0012 sets
 * user_id null on deletion), and auth-js throws synchronously on a non-uuid
 * id, so a null id must never reach getUserById. Any lookup failure renders
 * the order without an email rather than failing the page.
 */
export async function lookupCustomerEmail(
  auth: {
    getUserById(
      id: string,
    ): Promise<{ data: { user: { email?: string | null } | null }; error: unknown }>;
  },
  userId: string | null,
): Promise<string | null> {
  if (!userId) {
    return null;
  }
  try {
    const { data } = await auth.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

const PRODUCT_COLUMNS =
  'id, name, slug, description, base_price_cents, currency, image_url, active, cad_model, ' +
  'display_order, availability, sizing_modes, updated_at';

export async function listProducts(): Promise<ProductRow[]> {
  if (shouldUseFake()) {
    return [...fakeProducts].sort(compareShopOrder);
  }
  const client = await serviceClient();
  const { data, error } = await client
    .from('products')
    .select(PRODUCT_COLUMNS)
    .order('display_order')
    .order('name')
    .limit(PRODUCT_LIST_LIMIT);
  if (error) {
    throw error;
  }
  return (data ?? []) as unknown as ProductRow[];
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
  return (data as unknown as ProductRow | null) ?? null;
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

const IMAGE_COLUMNS = 'id, product_id, storage_path, alt_text, sort_order, is_main, created_at';

/** One product's gallery, in display order. Bounded by the per-product cap. */
export async function listProductImages(productId: string): Promise<ProductImageRow[]> {
  if (!isUuid(productId)) {
    return [];
  }
  if (shouldUseFake()) {
    return fakeProductImages
      .filter((row) => row.product_id === productId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }
  const client = await serviceClient();
  const { data, error } = await client
    .from('product_images')
    .select(IMAGE_COLUMNS)
    .eq('product_id', productId)
    .order('sort_order')
    .order('created_at')
    .limit(MAX_IMAGES_PER_PRODUCT);
  if (error) {
    throw error;
  }
  return (data ?? []) as ProductImageRow[];
}

/** Main image per product for the list page; at most one per product (0023 index). */
export async function listMainImages(productIds: string[]): Promise<Map<string, ProductImageRow>> {
  const ids = productIds.filter(isUuid).slice(0, PRODUCT_LIST_LIMIT);
  if (ids.length === 0) {
    return new Map();
  }
  let rows: ProductImageRow[];
  if (shouldUseFake()) {
    rows = fakeProductImages.filter((row) => row.is_main && ids.includes(row.product_id));
  } else {
    const client = await serviceClient();
    const { data, error } = await client
      .from('product_images')
      .select(IMAGE_COLUMNS)
      .in('product_id', ids)
      .eq('is_main', true)
      .limit(ids.length);
    if (error) {
      throw error;
    }
    rows = (data ?? []) as ProductImageRow[];
  }
  return new Map(rows.map((row) => [row.product_id, row]));
}
