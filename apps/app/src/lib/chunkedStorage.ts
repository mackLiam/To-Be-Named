/**
 * Session storage over a small-value key/value store (expo-secure-store on
 * native). SecureStore values should stay under 2048 bytes and a Supabase
 * session is larger, so a value is split into chunks under `${key}.${i}`
 * with the chunk count under `${key}.n`.
 *
 * Any missing or malformed piece reads as null: a corrupt store means signed
 * out, never a crash. supabase-js also treats a non-JSON value as absent, so
 * a torn write (old count, mixed chunks) lands in the same place.
 */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** Under SecureStore's 2048-byte value guidance, with headroom. */
export const CHUNK_BYTES = 1800;

/** Upper bound on chunks read back; a larger count is treated as corrupt. */
const MAX_CHUNKS = 64;

/** SecureStore keys allow only [A-Za-z0-9._-]. */
export function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function utf8Bytes(char: string): number {
  const point = char.codePointAt(0) ?? 0;
  return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

/** Split on code point boundaries so no chunk exceeds maxBytes of UTF-8. */
export function splitUtf8(value: string, maxBytes = CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of value) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  chunks.push(current);
  return chunks;
}

function parseCount(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n >= 1 && n <= MAX_CHUNKS ? n : null;
}

/** Shape matches supabase-js SupportedStorage. */
export function chunkedStorage(kv: KeyValueStore) {
  return {
    async getItem(key: string): Promise<string | null> {
      const base = safeKey(key);
      try {
        const n = parseCount(await kv.getItem(`${base}.n`));
        if (n === null) {
          return null;
        }
        const parts = await Promise.all(
          Array.from({ length: n }, (_, i) => kv.getItem(`${base}.${i}`)),
        );
        return parts.some((part) => part === null) ? null : parts.join('');
      } catch {
        return null;
      }
    },

    async setItem(key: string, value: string): Promise<void> {
      const base = safeKey(key);
      const previous = parseCount(await kv.getItem(`${base}.n`).catch(() => null)) ?? 0;
      const chunks = splitUtf8(value);
      if (chunks.length > MAX_CHUNKS) {
        throw new Error('Value too large for chunked storage.');
      }
      for (const [i, chunk] of chunks.entries()) {
        await kv.setItem(`${base}.${i}`, chunk);
      }
      await kv.setItem(`${base}.n`, String(chunks.length));
      for (let i = chunks.length; i < previous; i++) {
        await kv.deleteItem(`${base}.${i}`);
      }
    },

    /** Chunks first, count last, so an interrupted remove is retried in full.
     * An unreadable count sweeps every possible chunk: sign-out must not leave
     * token fragments in the keychain. */
    async removeItem(key: string): Promise<void> {
      const base = safeKey(key);
      const raw = await kv.getItem(`${base}.n`).catch(() => '');
      const n = parseCount(raw) ?? (raw === null ? 0 : MAX_CHUNKS);
      for (let i = 0; i < n; i++) {
        await kv.deleteItem(`${base}.${i}`);
      }
      await kv.deleteItem(`${base}.n`);
    },
  };
}
