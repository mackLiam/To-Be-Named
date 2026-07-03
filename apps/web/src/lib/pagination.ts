/**
 * Pagination helpers. Every admin list is bounded: page size is clamped to
 * MAX_PAGE_SIZE so a crafted query string can never ask for an unbounded
 * result set (engineering standards: no unbounded queries).
 *
 * We detect "is there a next page" with a one-row lookahead (request
 * pageSize + 1 rows) instead of a separate COUNT query, which keeps each list
 * to a single bounded round trip.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePageParam(value: string | string[] | undefined, fallback = 1): number {
  const parsed = Number.parseInt(firstValue(value) ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function parsePageSizeParam(
  value: string | string[] | undefined,
  fallback = DEFAULT_PAGE_SIZE,
): number {
  const parsed = Number.parseInt(firstValue(value) ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Inclusive [from, to] range for a Supabase .range() call that fetches one
 * extra row (pageSize + 1) so hasNext can be computed without a COUNT.
 */
export function lookaheadRange(page: number, pageSize: number): { from: number; to: number } {
  const from = (page - 1) * pageSize;
  const to = from + pageSize; // inclusive upper bound => pageSize + 1 rows
  return { from, to };
}

/**
 * Split a lookahead result: if more than pageSize rows came back there is a
 * next page; trim the extra row off the returned page.
 */
export function splitLookahead<T>(rows: T[], pageSize: number): { rows: T[]; hasNext: boolean } {
  const hasNext = rows.length > pageSize;
  return { rows: hasNext ? rows.slice(0, pageSize) : rows, hasNext };
}
