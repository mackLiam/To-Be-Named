// Pipeline, scan, and order state machines (DESIGN.md section 6 and section 8).

export const PIPELINE_STEPS = [
  'captured',
  'uploaded',
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

// Linear happy path. Any step may transition to "failed"; the worker is
// responsible for retrying a failed job back into the step it failed from,
// so "failed" itself has no forward transitions here.
export const VALID_TRANSITIONS: Record<PipelineStep, readonly PipelineStep[]> = {
  captured: ['uploaded', 'failed'],
  uploaded: ['measuring', 'failed'],
  measuring: ['measured', 'failed'],
  measured: ['generating_cad', 'failed'],
  generating_cad: ['stl_ready', 'failed'],
  stl_ready: ['queued_for_print', 'failed'],
  queued_for_print: ['printing', 'failed'],
  printing: ['shipped', 'failed'],
  shipped: [],
  failed: [],
};
