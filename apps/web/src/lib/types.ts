import type { MeasurementKey } from '@forms/shared';

// Row shapes mirror the columns in supabase/migrations/0001_schema.sql exactly.

export interface JobRow {
  id: string;
  order_id: string | null;
  scan_id: string;
  step: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error: JobError | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface OrderRow {
  id: string;
  // Null once the customer deleted their account (migration 0012).
  user_id: string | null;
  status: string;
  amount_cents: number | null;
  product_id: string;
  // Flattened from the products join: orders has no currency or name column.
  product_name: string | null;
  currency: string | null;
  scan_id_left: string | null;
  scan_id_right: string | null;
  tracking_carrier: string | null;
  tracking_number: string | null;
  // Migration 0024: set on a remake, pointing at the order it replaces.
  remake_of: string | null;
  remake_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** order_refunds (migration 0025). */
export interface RefundRow {
  id: number;
  seq: number;
  kind: string;
  amount_cents: number;
  stripe_refund_id: string;
  stripe_status: string | null;
  actor: string;
  created_at: string;
}

/** A remake of the order on the page (orders.remake_of = that order). */
export interface RemakeChild {
  id: string;
  status: string;
  remake_reason: string | null;
  created_at: string;
}

/** One admin_order_timeline row (migration 0026). */
export interface TimelineRow {
  source: 'audit' | 'note';
  entry_id: number;
  actor: string;
  action: string;
  detail: Record<string, unknown> | null;
  body: string | null;
  created_at: string;
}

export interface OrderDetail extends OrderRow {
  address: Record<string, unknown> | null;
  // Payment columns (migration 0013); written only by the Stripe webhook RPCs.
  stripe_payment_intent: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  // Migration 0025: Stripe's cumulative refunded total, from the webhook.
  stripe_refunded_cents: number | null;
  customer_email: string | null;
  jobs: Pick<JobRow, 'id' | 'scan_id' | 'step' | 'status'>[];
  refunds: RefundRow[];
  remakes: RemakeChild[];
}

/** One page of an order's timeline; rows null when it could not be read. */
export interface TimelinePage {
  rows: TimelineRow[] | null;
  page: number;
  hasNext: boolean;
}

/** admin_find_customers row (migration 0026). */
export interface CustomerRow {
  user_id: string;
  email: string;
  is_anonymous: boolean;
  created_at: string;
  deletion_requested_at: string | null;
  deletion_reason: string | null;
  order_count: number;
  open_order_count: number;
  scan_count: number;
  scan_statuses: Record<string, number>;
}

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  base_price_cents: number;
  currency: string;
  image_url: string | null;
  active: boolean;
  cad_model: Record<string, unknown> | null;
  // Migration 0022. availability is checked against AVAILABILITIES in
  // lib/catalog.ts; sizing_modes against SIZING_MODES.
  display_order: number;
  availability: string;
  sizing_modes: string[];
  updated_at: string;
}

/** product_images (migration 0023). */
export interface ProductImageRow {
  id: string;
  product_id: string;
  storage_path: string;
  alt_text: string;
  sort_order: number;
  is_main: boolean;
  created_at: string;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Shape written into pipeline_jobs.error by the measure worker on a gate
 * failure. Read defensively: this is JSONB, so any field may be absent.
 */
export interface JobError {
  message?: string;
  gates?: GateResult[];
}

export interface GateResult {
  key: string;
  value: number | null;
  min?: number;
  max?: number;
  ok: boolean;
}

export interface TriageData {
  job: {
    id: string;
    scan_id: string;
    step: string;
    status: string;
    error: JobError | null;
  };
  gates: GateResult[];
  // The 25-variable payload for the scan, if extraction produced one.
  values: Partial<Record<MeasurementKey, number>> | null;
}
