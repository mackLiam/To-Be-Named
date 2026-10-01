import { describe, expect, it } from 'vitest';

import { MEASUREMENT_KEYS } from '@forms/shared';

import type { Measurements } from '@forms/shared';

import {
  deleteErrorMessage,
  FAILED_STEP_GUIDANCE,
  FAILED_STEPS,
  failedStepGuidance,
  orderableLegs,
  toFailedStep,
  groupScanSessions,
  latestMeasurements,
  newestOrderableSessionKey,
  sessionStatus,
  SLICE_DIMS,
  SLICES,
  sliceKey,
  type Scan,
} from './library';

function scan(overrides: Partial<Scan> & Pick<Scan, 'id'>): Scan {
  return {
    leg: 'L',
    status: 'ready',
    pairId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    failedStep: null,
    ...overrides,
  };
}

function first<T>(items: readonly T[]): T {
  const [head] = items;
  if (head === undefined) {
    throw new Error('expected at least one item');
  }
  return head;
}

describe('groupScanSessions', () => {
  it('joins the left and right rows of one pair into one session', () => {
    const sessions = groupScanSessions([
      scan({ id: 'r', leg: 'R', pairId: 'p', createdAt: '2026-09-01T10:09:00.000Z' }),
      scan({ id: 'l', leg: 'L', pairId: 'p', createdAt: '2026-09-01T10:00:00.000Z' }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(first(sessions).key).toBe('p');
    expect(first(sessions).left?.id).toBe('l');
    expect(first(sessions).right?.id).toBe('r');
    expect(first(sessions).createdAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('keeps unpaired rows as one-leg sessions keyed by scan id', () => {
    const sessions = groupScanSessions([scan({ id: 'a', leg: 'R' }), scan({ id: 'b', leg: 'R' })]);
    expect(sessions.map((s) => s.key).sort()).toEqual(['a', 'b']);
    expect(sessions.every((s) => s.left === null && s.right !== null)).toBe(true);
  });

  it('sorts sessions newest first regardless of input order', () => {
    const sessions = groupScanSessions([
      scan({ id: 'old', pairId: 'p1', createdAt: '2026-01-01T00:00:00.000Z' }),
      scan({ id: 'new', pairId: 'p2', createdAt: '2026-09-01T00:00:00.000Z' }),
      scan({ id: 'mid', pairId: 'p3', createdAt: '2026-05-01T00:00:00.000Z' }),
    ]);
    expect(sessions.map((s) => s.key)).toEqual(['p2', 'p3', 'p1']);
  });

  it('keeps the newer row if a pair has two rows for one leg', () => {
    const sessions = groupScanSessions([
      scan({ id: 'newer', pairId: 'p', createdAt: '2026-09-02T00:00:00.000Z' }),
      scan({ id: 'older', pairId: 'p', createdAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(first(sessions).left?.id).toBe('newer');
  });

  it('returns no sessions for no scans', () => {
    expect(groupScanSessions([])).toEqual([]);
  });
});

describe('sessionStatus', () => {
  const pair = (left: Scan['status'], right: Scan['status']) =>
    first(
      groupScanSessions([
        scan({ id: 'l', leg: 'L', pairId: 'p', status: left }),
        scan({ id: 'r', leg: 'R', pairId: 'p', status: right }),
      ]),
    );

  it('is ready only when both legs are measured', () => {
    expect(sessionStatus(pair('ready', 'ready'))).toBe('ready');
  });

  it('is processing while either leg is still in flight', () => {
    expect(sessionStatus(pair('ready', 'processing'))).toBe('processing');
    expect(sessionStatus(pair('uploaded', 'ready'))).toBe('processing');
  });

  it('needs a rescan when any leg failed, even if the other is in flight', () => {
    expect(sessionStatus(pair('failed', 'ready'))).toBe('needs_rescan');
    expect(sessionStatus(pair('processing', 'failed'))).toBe('needs_rescan');
  });

  it('is one_leg for a single measured leg', () => {
    expect(sessionStatus(first(groupScanSessions([scan({ id: 'x' })])))).toBe('one_leg');
  });
});

describe('latestMeasurements', () => {
  it('keeps the newest row per scan', () => {
    const a = { Leg_Length: 380 } as never;
    const b = { Leg_Length: 390 } as never;
    const map = latestMeasurements([
      { scanId: 's', values: a, createdAt: '2026-09-01T00:00:00.000Z' },
      { scanId: 's', values: b, createdAt: '2026-09-02T00:00:00.000Z' },
    ]);
    expect(map.get('s')).toBe(b);
    expect(map.size).toBe(1);
  });
});

describe('slice keys', () => {
  it('cover exactly the 24 slice variables of the frozen schema', () => {
    const keys = SLICES.flatMap((s) => SLICE_DIMS.map((d) => sliceKey(s, d)));
    expect(['Leg_Length', ...keys].sort()).toEqual([...MEASUREMENT_KEYS].sort());
  });
});

describe('deleteErrorMessage', () => {
  it('explains a scan kept because it is on an order', () => {
    expect(deleteErrorMessage({ code: '23514' })).toMatch(/on an order/);
  });

  it('falls back to a retry message for anything else', () => {
    expect(deleteErrorMessage({ code: '42501' })).toMatch(/try again/);
    expect(deleteErrorMessage(new Error('network'))).toMatch(/try again/);
    expect(deleteErrorMessage(null)).toMatch(/try again/);
  });
});

describe('orderableLegs', () => {
  const VALUES = { Leg_Length: 390 } as Measurements;

  function session(left: Scan | null, right: Scan | null) {
    return { key: 'p', left, right, createdAt: '2026-09-01T10:00:00.000Z' };
  }

  it('includes both legs when both are ready and measured', () => {
    const l = scan({ id: 'l', leg: 'L', pairId: 'p' });
    const r = scan({ id: 'r', leg: 'R', pairId: 'p' });
    const measured = new Map([
      ['l', VALUES],
      ['r', VALUES],
    ]);
    expect(orderableLegs(session(l, r), measured).map((s) => s.id)).toEqual(['l', 'r']);
  });

  it('drops failed, processing and unvalidated legs', () => {
    const failed = scan({ id: 'f', leg: 'L', status: 'failed' });
    const processing = scan({ id: 'p', leg: 'R', status: 'processing' });
    // A failed or processing leg is excluded even if a row somehow exists for it.
    const withRows = new Map([
      ['f', VALUES],
      ['p', VALUES],
    ]);
    expect(orderableLegs(session(failed, processing), withRows)).toEqual([]);

    const readyNoRow = scan({ id: 'r', leg: 'R' });
    expect(orderableLegs(session(failed, readyNoRow), new Map())).toEqual([]);
    expect(orderableLegs(session(failed, readyNoRow), new Map([['r', VALUES]]))).toEqual([
      readyNoRow,
    ]);
  });

  it('handles a single-leg session', () => {
    const r = scan({ id: 'r', leg: 'R' });
    expect(orderableLegs(session(null, r), new Map([['r', VALUES]]))).toEqual([r]);
  });
});

describe('failed step guidance', () => {
  it('has copy for every failed_step value and a generic fallback', () => {
    expect(Object.keys(FAILED_STEP_GUIDANCE).sort()).toEqual([...FAILED_STEPS].sort());
    const all = [...FAILED_STEPS, null].map(failedStepGuidance);
    expect(new Set(all).size).toBe(all.length);
    for (const copy of all) {
      expect(copy).not.toMatch(/[\u2013\u2014]/);
      // Shown as a one-line detail under the leg row on the scan screen.
      expect(copy.length).toBeLessThanOrEqual(80);
    }
    expect(failedStepGuidance('measuring')).toMatch(/ankle to knee/);
    expect(failedStepGuidance('reconstructing')).toMatch(/all the way around/);
  });

  it('reads unknown column values as null', () => {
    expect(toFailedStep('measuring')).toBe('measuring');
    expect(toFailedStep('reconstructing')).toBe('reconstructing');
    expect(toFailedStep(null)).toBeNull();
    expect(toFailedStep('exporting')).toBeNull();
  });
});

describe('newestOrderableSessionKey', () => {
  it('picks the newest session with a measured leg', () => {
    const sessions = groupScanSessions([
      scan({ id: 'old', createdAt: '2026-08-01T10:00:00.000Z' }),
      scan({ id: 'new-failed', status: 'failed', createdAt: '2026-09-20T10:00:00.000Z' }),
      scan({ id: 'mid', pairId: 'p', createdAt: '2026-09-10T10:00:00.000Z' }),
      scan({
        id: 'mid-r',
        pairId: 'p',
        leg: 'R',
        status: 'processing',
        createdAt: '2026-09-10T10:05:00.000Z',
      }),
    ]);
    expect(newestOrderableSessionKey(sessions)).toBe('p');
  });

  it('is null when nothing is measured', () => {
    expect(newestOrderableSessionKey([])).toBeNull();
    expect(
      newestOrderableSessionKey(groupScanSessions([scan({ id: 'a', status: 'processing' })])),
    ).toBeNull();
  });
});
