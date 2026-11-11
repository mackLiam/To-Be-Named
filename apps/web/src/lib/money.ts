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
