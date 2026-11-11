import { MEASUREMENT_KEYS, type MeasurementKey } from '@forms/shared';

import { PRINT_QUEUE_STATUSES, type PrintQueueOrder } from './print-queue';
import type {
  CustomerRow,
  JobRow,
  OrderDetail,
  OrderRow,
  ProductImageRow,
  ProductRow,
  RefundRow,
  TimelineRow,
  TriageData,
} from './types';

/**
 * Deterministic placeholder data for when no backend is configured. Clearly
 * fake (obvious ids, obvious values) so it can never be mistaken for real
 * production data. The admin UI always shows a "FAKE DATA" banner in this mode.
 */

const t = (iso: string) => iso;

export const FAKE_TRIAGE_JOB_ID = '00000000-0000-4000-8000-000000000002';

export const fakeJobs: JobRow[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    order_id: '00000000-0000-4000-8000-0000000000a1',
    scan_id: '00000000-0000-4000-8000-0000000000b1',
    step: 'shipped',
    status: 'succeeded',
    attempts: 1,
    max_attempts: 3,
    error: null,
    created_at: t('2026-06-28T09:12:00Z'),
    updated_at: t('2026-06-29T14:03:00Z'),
    finished_at: t('2026-06-29T14:03:00Z'),
  },
  {
    id: FAKE_TRIAGE_JOB_ID,
    order_id: null,
    scan_id: '00000000-0000-4000-8000-0000000000b2',
    step: 'measuring',
    status: 'dead_letter',
    attempts: 3,
    max_attempts: 3,
    error: {
      message: 'Two measurements outside human-plausible range. Ask the user to rescan.',
      gates: [
        { key: 'S1_ISW', value: 12, min: 30, max: 90, ok: false },
        { key: 'S4_OD', value: 210, min: 40, max: 140, ok: false },
      ],
    },
    created_at: t('2026-07-01T18:40:00Z'),
    updated_at: t('2026-07-01T18:52:00Z'),
    finished_at: t('2026-07-01T18:52:00Z'),
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    order_id: '00000000-0000-4000-8000-0000000000a3',
    scan_id: '00000000-0000-4000-8000-0000000000b3',
    step: 'generating_cad',
    status: 'running',
    attempts: 1,
    max_attempts: 3,
    error: null,
    created_at: t('2026-07-02T08:05:00Z'),
    updated_at: t('2026-07-02T08:07:00Z'),
    finished_at: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    order_id: '00000000-0000-4000-8000-0000000000a4',
    scan_id: '00000000-0000-4000-8000-0000000000b4',
    step: 'stl_ready',
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    error: null,
    created_at: t('2026-07-02T10:22:00Z'),
    updated_at: t('2026-07-02T10:22:00Z'),
    finished_at: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    order_id: '00000000-0000-4000-8000-0000000000a5',
    scan_id: '00000000-0000-4000-8000-0000000000b5',
    step: 'generating_cad',
    status: 'failed',
    attempts: 2,
    max_attempts: 3,
    error: { message: 'Onshape regeneration timed out. Will retry with backoff.' },
    created_at: t('2026-07-02T11:01:00Z'),
    updated_at: t('2026-07-02T11:14:00Z'),
    finished_at: null,
  },
];

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const C3 = '00000000-0000-4000-8000-0000000000c3';

export const fakeProducts: ProductRow[] = [
  {
    id: C1,
    name: 'FAKE Custom Shin Guard',
    slug: 'custom-guard',
    description: 'Printed to your scan. One piece, vented shell.',
    base_price_cents: 8900,
    currency: 'usd',
    image_url: null,
    active: true,
    cad_model: {
      provider: 'dry_run',
      schema_version: '1.1.0',
      profile: { kind: 'identity' },
      ref: {},
      variable_map: null,
    },
    display_order: 0,
    availability: 'available',
    sizing_modes: ['custom'],
    updated_at: t('2026-06-20T12:00:00Z'),
  },
  {
    id: C2,
    name: 'FAKE Custom Shin Guard (pair)',
    slug: 'custom-guard-pair',
    description: 'Both legs scanned separately.',
    base_price_cents: 16900,
    currency: 'usd',
    image_url: null,
    active: true,
    cad_model: null,
    display_order: 1,
    availability: 'coming_soon',
    sizing_modes: ['custom'],
    updated_at: t('2026-06-20T12:00:00Z'),
  },
  {
    id: C3,
    name: 'FAKE Keeper Guard',
    slug: 'keeper-guard',
    description: 'Taller shell for goalkeepers.',
    base_price_cents: 10900,
    currency: 'usd',
    image_url: null,
    active: false,
    cad_model: null,
    display_order: 2,
    availability: 'coming_soon',
    sizing_modes: ['custom', 'preset_s', 'preset_m', 'preset_l'],
    updated_at: t('2026-06-21T09:00:00Z'),
  },
];

// Paths follow the 0023 shape; in fake mode there is no bucket, so the admin
// renders a placeholder instead of the picture.
export const fakeProductImages: ProductImageRow[] = [
  {
    id: '00000000-0000-4000-8000-0000000000e1',
    product_id: C1,
    storage_path: `${C1}/00000000-0000-4000-8000-0000000000e1.jpg`,
    alt_text: 'FAKE guard, front view',
    sort_order: 0,
    is_main: true,
    created_at: t('2026-06-20T12:00:00Z'),
  },
  {
    id: '00000000-0000-4000-8000-0000000000e2',
    product_id: C1,
    storage_path: `${C1}/00000000-0000-4000-8000-0000000000e2.webp`,
    alt_text: 'FAKE guard, side view',
    sort_order: 1,
    is_main: false,
    created_at: t('2026-06-20T12:05:00Z'),
  },
];

export const FAKE_CUSTOMER_ID = '00000000-0000-4000-8000-0000000000d1';

function fakeOrder(
  id: string,
  status: string,
  productId: string,
  amount: number | null,
  left: string | null,
  right: string | null,
  created: string,
  tracking: string | null = null,
  userId: string | null = FAKE_CUSTOMER_ID,
  remake: { of: string; reason: string } | null = null,
): OrderRow {
  const product = fakeProducts.find((p) => p.id === productId)!;
  return {
    id,
    user_id: userId,
    status,
    amount_cents: amount,
    product_id: productId,
    product_name: product.name,
    currency: product.currency,
    scan_id_left: left,
    scan_id_right: right,
    tracking_carrier: tracking ? 'UPS' : null,
    tracking_number: tracking,
    remake_of: remake?.of ?? null,
    remake_reason: remake?.reason ?? null,
    created_at: t(created),
    updated_at: t(created),
  };
}

const B = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;

export const fakeOrders: OrderRow[] = [
  // A remake of the delivered order a1 (0024: zero cost, created paid).
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a8',
    'paid',
    C1,
    0,
    B(1),
    null,
    '2026-07-03T09:00:00Z',
    null,
    FAKE_CUSTOMER_ID,
    { of: '00000000-0000-4000-8000-0000000000a1', reason: 'fit_too_tight' },
  ),
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a6',
    'pending_payment',
    C2,
    null,
    null,
    B(7),
    '2026-07-02T12:10:00Z',
  ),
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a5',
    'paid',
    C1,
    8900,
    B(5),
    null,
    '2026-07-02T10:58:00Z',
  ),
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a3',
    'in_production',
    C2,
    16900,
    B(3),
    B(6),
    '2026-07-02T07:55:00Z',
  ),
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a1',
    'delivered',
    C1,
    8900,
    B(1),
    null,
    '2026-06-28T09:00:00Z',
    'FAKE1Z999',
  ),
  // The customer deleted their account after delivery (0012: user_id null).
  fakeOrder(
    '00000000-0000-4000-8000-0000000000a7',
    'delivered',
    C1,
    8900,
    B(8),
    null,
    '2026-06-20T09:00:00Z',
    'FAKE1Z998',
    null,
  ),
];

const FAKE_REFUNDS: Record<string, RefundRow[]> = {
  '00000000-0000-4000-8000-0000000000a3': [
    {
      id: 1,
      seq: 1,
      kind: 'partial',
      amount_cents: 2000,
      stripe_refund_id: 're_FAKE_1',
      stripe_status: 'succeeded',
      actor: 'admin@example.test',
      created_at: t('2026-07-02T09:00:00Z'),
    },
  ],
};

export function fakeOrderDetail(id: string): OrderDetail | null {
  const order = fakeOrders.find((row) => row.id === id);
  if (!order) {
    return null;
  }
  const paid = order.status !== 'pending_payment' && !order.remake_of;
  const refunds = FAKE_REFUNDS[id] ?? [];
  return {
    ...order,
    stripe_payment_intent: paid ? `pi_FAKE_${order.id.slice(-2)}` : null,
    paid_at: order.status !== 'pending_payment' ? order.created_at : null,
    refunded_at: null,
    stripe_refunded_cents: refunds.length
      ? refunds.reduce((sum, r) => sum + r.amount_cents, 0)
      : null,
    address: {
      name: 'FAKE Customer',
      line1: '1 Example St',
      city: 'Springfield',
      postal_code: '00000',
      country: 'US',
    },
    customer_email: order.user_id ? 'fake.customer@example.com' : null,
    deletion_pending: false,
    jobs: fakeJobs
      .filter((job) => job.order_id === id)
      .map(({ id: jobId, scan_id, step, status }) => ({ id: jobId, scan_id, step, status })),
    refunds,
    remakes: fakeOrders
      .filter((row) => row.remake_of === id)
      .map(({ id: remakeId, status, remake_reason, created_at }) => ({
        id: remakeId,
        status,
        remake_reason,
        created_at,
      })),
  };
}

/** Newest first, like admin_order_timeline. */
export function fakeTimeline(id: string): TimelineRow[] {
  const order = fakeOrders.find((row) => row.id === id);
  if (!order) {
    return [];
  }
  const rows: TimelineRow[] = [
    {
      source: 'note',
      entry_id: 2,
      actor: 'admin@example.test',
      action: 'order.note',
      detail: null,
      body: 'FAKE note: customer asked about delivery by email.',
      created_at: t('2026-07-03T10:00:00Z'),
    },
    {
      source: 'audit',
      entry_id: 1,
      actor: 'stripe-webhook',
      action: 'order.status',
      detail: { from: 'pending_payment', to: 'paid' },
      body: null,
      created_at: order.created_at,
    },
  ];
  if (order.remake_of) {
    rows.splice(1, 0, {
      source: 'audit',
      entry_id: 3,
      actor: 'admin@example.test',
      action: 'order.remake_created',
      detail: { remake_of: order.remake_of, reason: order.remake_reason, legs: 'both' },
      body: null,
      created_at: order.created_at,
    });
  }
  return rows;
}

export const fakeCustomers: CustomerRow[] = [
  {
    user_id: FAKE_CUSTOMER_ID,
    email: 'fake.customer@example.com',
    is_anonymous: false,
    created_at: t('2026-06-01T09:00:00Z'),
    deletion_requested_at: null,
    deletion_reason: null,
    order_count: 5,
    open_order_count: 2,
    scan_count: 3,
    scan_statuses: { ready: 2, failed: 1 },
  },
  {
    user_id: '00000000-0000-4000-8000-0000000000d2',
    email: 'fake.leaving@example.com',
    is_anonymous: false,
    created_at: t('2026-06-05T09:00:00Z'),
    deletion_requested_at: t('2026-07-01T09:00:00Z'),
    deletion_reason: 'user_request',
    order_count: 0,
    open_order_count: 0,
    scan_count: 0,
    scan_statuses: {},
  },
];

// A plausible-looking 25-variable payload (millimeters), with the two values
// that tripped the gates in FAKE_TRIAGE_JOB_ID set to their out-of-range values.
function buildFakeValues(): Partial<Record<MeasurementKey, number>> {
  const base: Partial<Record<MeasurementKey, number>> = {};
  const defaults: Record<string, number> = {
    Leg_Length: 265,
    ISW: 62,
    ISD: 48,
    ICW: 70,
    ICD: 55,
    OW: 78,
    OD: 60,
  };
  for (const key of MEASUREMENT_KEYS) {
    if (key === 'Leg_Length') {
      base[key] = defaults.Leg_Length;
      continue;
    }
    const dim = key.split('_')[1] ?? '';
    base[key] = defaults[dim] ?? 60;
  }
  base.S1_ISW = 12; // out of range (gate floor 30)
  base.S4_OD = 210; // out of range (gate ceiling 140)
  return base;
}

export function fakeTriage(jobId: string): TriageData | null {
  const job = fakeJobs.find((row) => row.id === jobId);
  if (!job) {
    return null;
  }
  return {
    job: {
      id: job.id,
      scan_id: job.scan_id,
      step: job.step,
      status: job.status,
      error: job.error,
    },
    gates: job.error?.gates ?? [],
    values: job.step === 'measuring' ? buildFakeValues() : null,
  };
}

const FAKE_STL_STEPS = ['stl_ready', 'queued_for_print', 'printing', 'shipped'];

/** Paid and in_production orders, oldest payment first, with their CAD jobs. */
export function fakePrintQueue(): PrintQueueOrder[] {
  return fakeOrders
    .filter((row) => (PRINT_QUEUE_STATUSES as readonly string[]).includes(row.status))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((row) => ({
      order: { ...row, paid_at: row.created_at },
      jobs: fakeJobs
        .filter((job) => job.order_id === row.id)
        .map((job) => ({
          id: job.id,
          order_id: row.id,
          scan_id: job.scan_id,
          step: job.step,
          status: job.status,
          created_at: job.created_at,
          stl_path:
            job.status === 'succeeded' && FAKE_STL_STEPS.includes(job.step)
              ? `fake/${job.id}.stl`
              : null,
        })),
    }));
}
