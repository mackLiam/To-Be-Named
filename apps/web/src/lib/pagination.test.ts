import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  lookaheadRange,
  parsePageParam,
  parsePageSizeParam,
  splitLookahead,
} from './pagination';

describe('parsePageParam', () => {
  it('defaults to 1 for missing or invalid input', () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam('')).toBe(1);
    expect(parsePageParam('abc')).toBe(1);
    expect(parsePageParam('0')).toBe(1);
    expect(parsePageParam('-3')).toBe(1);
  });

  it('parses a valid page and takes the first of an array', () => {
    expect(parsePageParam('4')).toBe(4);
    expect(parsePageParam(['2', '9'])).toBe(2);
  });
});

describe('parsePageSizeParam', () => {
  it('defaults when missing or invalid', () => {
    expect(parsePageSizeParam(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSizeParam('nope')).toBe(DEFAULT_PAGE_SIZE);
  });

  it('clamps to MAX_PAGE_SIZE so queries stay bounded', () => {
    expect(parsePageSizeParam('10')).toBe(10);
    expect(parsePageSizeParam('99999')).toBe(MAX_PAGE_SIZE);
  });
});

describe('lookaheadRange', () => {
  it('produces an inclusive range that fetches pageSize + 1 rows', () => {
    expect(lookaheadRange(1, 25)).toEqual({ from: 0, to: 25 });
    expect(lookaheadRange(3, 10)).toEqual({ from: 20, to: 30 });
  });
});

describe('splitLookahead', () => {
  it('reports hasNext and trims the extra row', () => {
    const rows = [1, 2, 3, 4]; // pageSize 3 + 1 lookahead
    expect(splitLookahead(rows, 3)).toEqual({ rows: [1, 2, 3], hasNext: true });
  });

  it('reports no next page when the lookahead row is absent', () => {
    expect(splitLookahead([1, 2], 3)).toEqual({ rows: [1, 2], hasNext: false });
  });
});
