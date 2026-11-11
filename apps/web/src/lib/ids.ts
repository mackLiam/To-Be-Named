/** Framework-free id helpers, safe to import from client components. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params reach Postgres uuid columns; a malformed one is a 404, not a 500. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
