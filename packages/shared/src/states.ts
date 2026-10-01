// Pipeline, scan, and order state machines (DESIGN.md section 6 and section 8).

export const PIPELINE_STEPS = [
  'captured',
  'uploaded',
  'reconstructing',
  'measuring',
  'measured',
  'generating_cad',
  'stl_ready',
  'queued_for_print',
  'printing',
  'shipped',
  'failed',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const SCAN_STATUSES = ['capturing', 'uploaded', 'processing', 'ready', 'failed'] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'in_production',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Explicit table, mirrored verbatim in services/pipeline jobs/states.py and
// the pipeline_jobs step CHECK (supabase/migrations/0008_photo_capture.sql).
// A measure job ends at 'measured' (completed there); a CAD job is a separate
// job that starts at 'generating_cad' (DESIGN.md section 6). Any step may
// fail; 'failed' and 'shipped' have no transitions out.
export const VALID_TRANSITIONS: Record<PipelineStep, readonly PipelineStep[]> = {
  captured: ['uploaded', 'failed'],
  uploaded: ['reconstructing', 'measuring', 'failed'],
  reconstructing: ['measuring', 'failed'],
  measuring: ['measured', 'failed'],
  measured: ['failed'],
  generating_cad: ['stl_ready', 'failed'],
  stl_ready: ['queued_for_print', 'failed'],
  queued_for_print: ['printing', 'failed'],
  printing: ['shipped', 'failed'],
  shipped: [],
  failed: [],
};

// scans.capture_kind (0008). 'photos' bundles live under the derived prefix
// `${user_id}/${scan_id}/` in the meshes bucket; nothing stores the prefix.
export const CAPTURE_KINDS = ['mesh', 'photos'] as const;

export type CaptureKind = (typeof CAPTURE_KINDS)[number];
