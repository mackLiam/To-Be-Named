/**
 * Money helpers with no imports, so client components (the product form)
 * can use them without pulling @forms/shared's node-only validator.
 */

/** "8900" -> 8900. Whole non-negative cents only, no signs, decimals or exponents. */
export function parseCents(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!/^\d{1,9}$/.test(value)) {
    return null;
  }
  return Number(value);
}

export function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) {
    return '-';
  }
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
  });
}

/**
 * "12", "12.5" or "12.50" (major units, at most two decimals) -> 1250.
 * Matches formatMoney, which treats every currency as two-decimal.
 */
export function parseMoneyAmount(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
