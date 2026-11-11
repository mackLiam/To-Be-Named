import { describe, expect, it } from 'vitest';

import { getPackingSlipOrder, listPrintQueue } from './data';
import {
  MAX_QUEUE_PAGE,
  addressCompleteness,
  cadStateLabel,
  clampQueuePage,
  formatAge,
  hasStl,
  latestJobForScan,
  legsLabel,
  shapePackingSlip,
  shapeQueueRow,
  slipAddressLines,
  type QueueJob,
  type QueueOrder,
} from './print-queue';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const ORDER_ID = '9f1c2d3e-0000-4000-8000-000000000000';
const LEFT = '00000000-0000-4000-8000-0000000000b1';
const RIGHT = '00000000-0000-4000-8000-0000000000b2';

function order(over: Partial<QueueOrder> = {}): QueueOrder {
  return {
    id: ORDER_ID,
    product_name: 'Guard',
    scan_id_left: LEFT,
    scan_id_right: RIGHT,
    remake_of: null,
    remake_reason: null,
    paid_at: '2026-07-10T08:48:00Z',
    created_at: '2026-07-10T08:40:00Z',
    status: 'paid',
    ...over,
  };
}

function job(over: Partial<QueueJob> = {}): QueueJob {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    order_id: ORDER_ID,
    scan_id: LEFT,
    step: 'stl_ready',
    status: 'succeeded',
    created_at: '2026-07-10T09:00:00Z',
    stl_path: 'job/left.stl',
    ...over,
  };
}

describe('formatAge', () => {
  it('uses the two largest units', () => {
    expect(formatAge('2026-07-07T07:30:00Z', NOW)).toBe('3d 4h');
    expect(formatAge('2026-07-10T06:48:00Z', NOW)).toBe('5h 12m');
    expect(formatAge('2026-07-10T11:51:00Z', NOW)).toBe('9m');
    expect(formatAge('2026-07-10T11:59:30Z', NOW)).toBe('under 1m');
  });

  it('is "-" for missing or bad input and never negative', () => {
    expect(formatAge(null, NOW)).toBe('-');
    expect(formatAge('nope', NOW)).toBe('-');
    expect(formatAge('2026-07-11T00:00:00Z', NOW)).toBe('under 1m');
  });
});

describe('clampQueuePage', () => {
  it('bounds the page to 1..MAX_QUEUE_PAGE', () => {
    expect(clampQueuePage(0)).toBe(1);
    expect(clampQueuePage(-4)).toBe(1);
    expect(clampQueuePage(Number.NaN)).toBe(1);
    expect(clampQueuePage(3.9)).toBe(3);
    expect(clampQueuePage(10 ** 9)).toBe(MAX_QUEUE_PAGE);
  });
});

describe('job helpers', () => {
  it('picks the newest job for a scan', () => {
    const older = job({ id: 'old', created_at: '2026-07-10T08:00:00Z', status: 'failed' });
    const newer = job({ id: 'new' });
    expect(latestJobForScan(LEFT, [older, newer])?.id).toBe('new');
    expect(latestJobForScan(RIGHT, [older, newer])).toBeNull();
  });

  it('treats a missing or blank STL path as unavailable', () => {
    expect(hasStl(job())).toBe(true);
    expect(hasStl(job({ stl_path: null }))).toBe(false);
    expect(hasStl(job({ stl_path: '  ' }))).toBe(false);
    expect(hasStl(null)).toBe(false);
  });

  it('labels job state, including no job and unknown steps', () => {
    expect(cadStateLabel(null)).toBe('No CAD job');
    expect(cadStateLabel({ step: 'generating_cad', status: 'running' })).toBe(
      'Generating CAD, Running',
    );
    expect(cadStateLabel({ step: 'odd_step', status: 'odd' })).toBe('odd_step, odd');
  });
});

describe('shapeQueueRow', () => {
  it('shapes a two-leg order with one ready STL and one missing', () => {
    const row = shapeQueueRow(
      {
        order: order(),
        jobs: [
          job(),
          job({
            id: 'r',
            scan_id: RIGHT,
            stl_path: null,
            step: 'generating_cad',
            status: 'running',
          }),
        ],
      },
      NOW,
    );
    expect(row.reference).toBe('9F1C2D3E');
    expect(row.age).toBe('3h 12m');
    expect(row.isRemake).toBe(false);
    expect(row.legs.map((l) => l.side)).toEqual(['Left', 'Right']);
    expect(row.legs[0]).toMatchObject({
      stlReady: true,
      stlHref: '/admin/api/stl/00000000-0000-4000-8000-000000000011',
    });
    expect(row.legs[1]).toMatchObject({ stlReady: false, stlHref: null });
  });

  it('shows a leg with no job at all', () => {
    const row = shapeQueueRow({ order: order({ scan_id_right: null }), jobs: [] }, NOW);
    expect(row.legs).toHaveLength(1);
    expect(row.legs[0]).toMatchObject({ jobId: null, state: 'No CAD job', stlHref: null });
  });

  it('marks a remake and falls back to created_at and a product placeholder', () => {
    const row = shapeQueueRow(
      {
        order: order({
          remake_of: '00000000-0000-4000-8000-0000000000a1',
          remake_reason: 'fit_too_tight',
          paid_at: null,
          product_name: null,
        }),
        jobs: [],
      },
      NOW,
    );
    expect(row.isRemake).toBe(true);
    expect(row.remakeReason).toBe('fit_too_tight');
    expect(row.product).toBe('Unknown product');
    expect(row.age).toBe('3h 20m');
  });

  it('never carries a price field', () => {
    const row = shapeQueueRow({ order: order(), jobs: [] }, NOW);
    expect(Object.keys(row).join(' ')).not.toMatch(/amount|price|cents/);
  });
});

describe('packing slip', () => {
  const full = {
    name: ' Pat Lee ',
    line1: '1 Example St',
    city: 'Springfield',
    postal_code: '00000',
    country: 'US',
  };

  it('formats a full address one line per field', () => {
    const slip = shapePackingSlip({ ...order(), address: full });
    expect(slip.addressLines).toEqual(['Pat Lee', '1 Example St', 'Springfield', '00000', 'US']);
    expect(slip.addressStatus).toBe('complete');
    expect(slip.legs).toBe('Left + Right');
    expect(slip.reference).toBe('9F1C2D3E');
  });

  it('flags no address', () => {
    expect(shapePackingSlip({ ...order(), address: null }).addressStatus).toBe('none');
    expect(slipAddressLines({})).toEqual([]);
    expect(addressCompleteness({ name: '  ', line1: 5 })).toBe('none');
  });

  it('flags a partial address', () => {
    const slip = shapePackingSlip({
      ...order(),
      address: { name: 'Pat Lee', city: 'Springfield' },
    });
    expect(slip.addressStatus).toBe('partial');
    expect(slip.addressLines).toEqual(['Pat Lee', 'Springfield']);
    expect(addressCompleteness({ line1: '1 Example St' })).toBe('partial');
  });

  it('marks a remake and exposes no price, measurement or scan fields', () => {
    const slip = shapePackingSlip({
      ...order({ remake_of: '00000000-0000-4000-8000-0000000000a1' }),
      address: full,
    });
    expect(slip.isRemake).toBe(true);
    expect(Object.keys(slip).sort()).toEqual([
      'addressLines',
      'addressStatus',
      'isRemake',
      'legs',
      'product',
      'reference',
    ]);
  });

  it('ignores non-string address values', () => {
    expect(slipAddressLines({ line1: { nested: true }, country: 'US' })).toEqual(['US']);
  });
});

describe('legsLabel', () => {
  it('names the legs', () => {
    expect(legsLabel({ scan_id_left: LEFT, scan_id_right: null })).toBe('Left');
    expect(legsLabel({ scan_id_left: null, scan_id_right: RIGHT })).toBe('Right');
    expect(legsLabel({ scan_id_left: null, scan_id_right: null })).toBe('-');
  });
});

describe('listPrintQueue (fake data)', () => {
  it('returns only paid and in_production orders, oldest payment first', async () => {
    const { rows } = await listPrintQueue({ page: 1, pageSize: 25 });
    expect(rows.length).toBeGreaterThan(0);
    for (const entry of rows) {
      expect(['paid', 'in_production']).toContain(entry.order.status);
    }
    const times = rows.map((r) => Date.parse(r.order.paid_at ?? r.order.created_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('paginates with a lookahead and an out-of-range page is empty', async () => {
    const first = await listPrintQueue({ page: 1, pageSize: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.hasNext).toBe(true);
    const beyond = await listPrintQueue({ page: MAX_QUEUE_PAGE + 5, pageSize: 25 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.hasNext).toBe(false);
  });
});

describe('getPackingSlipOrder (fake data)', () => {
  it('reads a known order and refuses a malformed or unknown id', async () => {
    const found = await getPackingSlipOrder('00000000-0000-4000-8000-0000000000a5');
    expect(found?.product_name).toBeTruthy();
    expect(found?.address).not.toBeNull();
    expect(await getPackingSlipOrder('not-a-uuid')).toBeNull();
    expect(await getPackingSlipOrder('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});
