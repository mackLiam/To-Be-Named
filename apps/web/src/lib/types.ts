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
  user_id: string;
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
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends OrderRow {
  address: Record<string, unknown> | null;
  // Payment columns (migration 0013); written only by the Stripe webhook RPCs.
  stripe_payment_intent: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  customer_email: string | null;
  jobs: Pick<JobRow, 'id' | 'scan_id' | 'step' | 'status'>[];
  history: AuditRow[];
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
  updated_at: string;
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
