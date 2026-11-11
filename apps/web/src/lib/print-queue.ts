import { formatAddress } from './shop';
import { jobStatusMeta, shortId } from './view';

/**
 * Print queue and packing slip shaping. Pure functions over rows already read
 * by data.ts; no IO here. The queue is read-only (status changes stay on the
 * order page) and the slip is paper: it carries no prices, measurements or
 * scan data (minors' body data, CLAUDE.md gotcha 5), so the slip shape below
 * has no field that could hold them.
 */

/** Orders waiting on the printer: paid, or already in production. */
export const PRINT_QUEUE_STATUSES = ['paid', 'in_production'] as const;

/** Pages beyond this are treated as the last allowed page, never an unbounded offset. */
export const MAX_QUEUE_PAGE = 1000;

/** CAD jobs read per order: one per leg, plus retries and re-enqueues. */
export const JOBS_PER_ORDER = 8;

export function clampQueuePage(page: number): number {
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }
  return Math.min(Math.floor(page), MAX_QUEUE_PAGE);
}

/** A CAD job (product_id set) as the queue reads it; stl_path is artifacts->>stl_path. */
export interface QueueJob {
  id: string;
  order_id: string;
  scan_id: string;
  step: string;
  status: string;
  created_at: string;
  stl_path: string | null;
}

export interface QueueOrder {
  id: string;
  product_name: string | null;
  scan_id_left: string | null;
  scan_id_right: string | null;
  remake_of: string | null;
  remake_reason: string | null;
  paid_at: string | null;
  created_at: string;
  status: string;
}

export interface PrintQueueOrder {
  order: QueueOrder;
  jobs: QueueJob[];
}

const STEP_LABEL: Record<string, string> = {
  captured: 'Captured',
  uploaded: 'Uploaded',
  reconstructing: 'Reconstructing',
  measuring: 'Measuring',
  measured: 'Measured',
  generating_cad: 'Generating CAD',
  stl_ready: 'STL ready',
  queued_for_print: 'Queued for print',
  printing: 'Printing',
  shipped: 'Shipped',
  failed: 'Failed',
};

export interface QueueLeg {
  side: 'Left' | 'Right';
  /** Null when the order has a job-less leg (the CAD job was never enqueued). */
  jobId: string | null;
  state: string;
  stlReady: boolean;
  /** The existing break-glass route; it audits and signs at click time. */
  stlHref: string | null;
}

export interface QueueRow {
  id: string;
  reference: string;
  product: string;
  status: string;
  legs: QueueLeg[];
  age: string;
  paidAt: string | null;
  isRemake: boolean;
  remakeReason: string | null;
}

export function stlHref(jobId: string): string {
  return `/admin/api/stl/${jobId}`;
}

/** Newest CAD job for a scan; older ones are retries. */
export function latestJobForScan(scanId: string, jobs: readonly QueueJob[]): QueueJob | null {
  let best: QueueJob | null = null;
  for (const job of jobs) {
    if (job.scan_id !== scanId) {
      continue;
    }
    if (!best || Date.parse(job.created_at) > Date.parse(best.created_at)) {
      best = job;
    }
  }
  return best;
}

export function cadStateLabel(job: Pick<QueueJob, 'step' | 'status'> | null): string {
  if (!job) {
    return 'No CAD job';
  }
  const status = jobStatusMeta(job.status).label;
  return `${STEP_LABEL[job.step] ?? job.step}, ${status}`;
}

/** STL is downloadable only when the job recorded a path; the route 404s otherwise. */
export function hasStl(job: Pick<QueueJob, 'stl_path'> | null): boolean {
  return job !== null && typeof job.stl_path === 'string' && job.stl_path.trim() !== '';
}

/**
 * Time since payment as the two largest whole units: "3d 4h", "5h 12m",
 * "9m", "under 1m". A missing or unparseable time is "-"; a time in the
 * future (clock skew) counts as "under 1m".
 */
export function formatAge(fromIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) {
    return '-';
  }
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) {
    return '-';
  }
  const minutes = Math.floor(Math.max(0, nowMs - from) / 60_000);
  if (minutes < 1) {
    return 'under 1m';
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function sides(order: QueueOrder): { side: 'Left' | 'Right'; scanId: string }[] {
  const out: { side: 'Left' | 'Right'; scanId: string }[] = [];
  if (order.scan_id_left) {
    out.push({ side: 'Left', scanId: order.scan_id_left });
  }
  if (order.scan_id_right) {
    out.push({ side: 'Right', scanId: order.scan_id_right });
  }
  return out;
}

export function legsLabel(order: Pick<QueueOrder, 'scan_id_left' | 'scan_id_right'>): string {
  const parts = [order.scan_id_left && 'Left', order.scan_id_right && 'Right'].filter(Boolean);
  return parts.length > 0 ? parts.join(' + ') : '-';
}

export function shapeQueueRow({ order, jobs }: PrintQueueOrder, nowMs: number): QueueRow {
  const paidAt = order.paid_at ?? order.created_at;
  return {
    id: order.id,
    reference: shortId(order.id).toUpperCase(),
    product: order.product_name ?? 'Unknown product',
    status: order.status,
    legs: sides(order).map(({ side, scanId }) => {
      const job = latestJobForScan(scanId, jobs);
      const ready = hasStl(job);
      return {
        side,
        jobId: job?.id ?? null,
        state: cadStateLabel(job),
        stlReady: ready,
        stlHref: job && ready ? stlHref(job.id) : null,
      };
    }),
    age: formatAge(paidAt, nowMs),
    paidAt,
    isRemake: order.remake_of !== null,
    remakeReason: order.remake_reason,
  };
}

// ---------------------------------------------------------------------------
// Packing slip.
// ---------------------------------------------------------------------------

export interface SlipOrder {
  id: string;
  product_name: string | null;
  scan_id_left: string | null;
  scan_id_right: string | null;
  remake_of: string | null;
  address: Record<string, unknown> | null;
}

/** none: nothing usable. partial: some lines, but street or country is missing. */
export type AddressCompleteness = 'none' | 'partial' | 'complete';

export interface PackingSlip {
  reference: string;
  product: string;
  legs: string;
  isRemake: boolean;
  addressLines: string[];
  addressStatus: AddressCompleteness;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** Address lines in mailing order, one per entry; empty when there is nothing usable. */
export function slipAddressLines(address: Record<string, unknown> | null | undefined): string[] {
  const text = formatAddress(address);
  return text === '' ? [] : text.split('\n');
}

/** A parcel needs at least a street line and a country; anything less is flagged. */
export function addressCompleteness(
  address: Record<string, unknown> | null | undefined,
): AddressCompleteness {
  if (slipAddressLines(address).length === 0) {
    return 'none';
  }
  return address && hasText(address.line1) && hasText(address.country) ? 'complete' : 'partial';
}

export function shapePackingSlip(order: SlipOrder): PackingSlip {
  return {
    reference: shortId(order.id).toUpperCase(),
    product: order.product_name ?? 'Unknown product',
    legs: legsLabel(order),
    isRemake: order.remake_of !== null,
    addressLines: slipAddressLines(order.address),
    addressStatus: addressCompleteness(order.address),
  };
}
