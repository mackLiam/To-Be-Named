import { describe, expect, it } from 'vitest';

import { MEASUREMENT_KEYS } from '@forms/shared';

import {
  deleteErrorMessage,
  groupScanSessions,
  latestMeasurements,
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
