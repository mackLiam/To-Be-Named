import type { MeasurementKey } from '@zells/shared';

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
  status: string;
  amount_cents: number | null;
  currency: string | null;
  product_id: string;
  scan_id_left: string | null;
  scan_id_right: string | null;
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
