import { MEASUREMENT_KEYS, type MeasurementKey } from '@zells/shared';

import type { JobRow, OrderRow, TriageData } from './types';

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

export const fakeOrders: OrderRow[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    status: 'delivered',
    amount_cents: 8900,
    currency: 'usd',
    product_id: '00000000-0000-4000-8000-0000000000c1',
    scan_id_left: '00000000-0000-4000-8000-0000000000b1',
    scan_id_right: null,
    created_at: t('2026-06-28T09:00:00Z'),
  },
  {
    id: '00000000-0000-4000-8000-0000000000a3',
    status: 'in_production',
    amount_cents: 12900,
    currency: 'usd',
    product_id: '00000000-0000-4000-8000-0000000000c2',
    scan_id_left: '00000000-0000-4000-8000-0000000000b3',
    scan_id_right: '00000000-0000-4000-8000-0000000000b6',
    created_at: t('2026-07-02T07:55:00Z'),
  },
  {
    id: '00000000-0000-4000-8000-0000000000a5',
    status: 'paid',
    amount_cents: 8900,
    currency: 'usd',
    product_id: '00000000-0000-4000-8000-0000000000c1',
    scan_id_left: '00000000-0000-4000-8000-0000000000b5',
    scan_id_right: null,
    created_at: t('2026-07-02T10:58:00Z'),
  },
  {
    id: '00000000-0000-4000-8000-0000000000a6',
    status: 'pending_payment',
    amount_cents: null,
    currency: 'usd',
    product_id: '00000000-0000-4000-8000-0000000000c2',
    scan_id_left: null,
    scan_id_right: '00000000-0000-4000-8000-0000000000b7',
    created_at: t('2026-07-02T12:10:00Z'),
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
