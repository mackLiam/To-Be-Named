import { describe, expect, it } from 'vitest';

import {
  CHUNK_BYTES,
  chunkedStorage,
  safeKey,
  splitUtf8,
  type KeyValueStore,
} from './chunkedStorage';

function memoryKv() {
  const map = new Map<string, string>();
  const kv: KeyValueStore = {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`invalid key ${key}`);
      if (new TextEncoder().encode(value).length > 2048) throw new Error('value too large');
      map.set(key, value);
    },
    deleteItem: async (key) => {
      map.delete(key);
    },
  };
  return { kv, map };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('safeKey', () => {
  it('keeps allowed characters and replaces the rest', () => {
    expect(safeKey('sb-abc.def_1-auth-token')).toBe('sb-abc.def_1-auth-token');
    expect(safeKey('sb:abc/def token@x')).toBe('sb_abc_def_token_x');
  });
});

describe('splitUtf8', () => {
  it('returns one empty chunk for an empty value', () => {
    expect(splitUtf8('')).toEqual(['']);
  });

  it('never exceeds the byte limit and never splits a multi-byte character', () => {
    const value = 'a'.repeat(1799) + 'é' + '\u{1F600}'.repeat(600) + 'z';
    const chunks = splitUtf8(value);
    expect(chunks.join('')).toBe(value);
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(CHUNK_BYTES);
      // A lone surrogate would mean a code point was cut in half.
      expect(chunk).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });
});

describe('chunkedStorage', () => {
  const session = JSON.stringify({ access_token: 'x'.repeat(4000), refresh_token: 'r' });

  it('round-trips a value larger than one SecureStore entry', async () => {
    const { kv, map } = memoryKv();
    const store = chunkedStorage(kv);
    await store.setItem('sb-proj-auth-token', session);
    expect(map.get('sb-proj-auth-token.n')).toBe('3');
    expect(await store.getItem('sb-proj-auth-token')).toBe(session);
  });

  it('sanitizes the key on every operation', async () => {
    const { kv, map } = memoryKv();
    const store = chunkedStorage(kv);
    await store.setItem('sb:proj/token', 'v');
    expect(map.get('sb_proj_token.0')).toBe('v');
    expect(await store.getItem('sb:proj/token')).toBe('v');
    await store.removeItem('sb:proj/token');
    expect(map.size).toBe(0);
  });

  it('removes stale chunks when a shorter value is written', async () => {
    const { kv, map } = memoryKv();
    const store = chunkedStorage(kv);
    await store.setItem('k', session);
    await store.setItem('k', 'short');
    expect([...map.keys()].sort()).toEqual(['k.0', 'k.n']);
    expect(await store.getItem('k')).toBe('short');
  });

  it('returns null for an absent key', async () => {
    const { kv } = memoryKv();
    expect(await chunkedStorage(kv).getItem('k')).toBeNull();
  });

  it('returns null when any chunk is missing', async () => {
    const { kv, map } = memoryKv();
    const store = chunkedStorage(kv);
    await store.setItem('k', session);
    map.delete('k.1');
    expect(await store.getItem('k')).toBeNull();
  });

  it.each(['', 'x', '-1', '0', '1.5', '9999'])('returns null for a corrupt count %j', async (n) => {
    const { kv, map } = memoryKv();
    map.set('k.n', n);
    map.set('k.0', 'v');
    expect(await chunkedStorage(kv).getItem('k')).toBeNull();
  });

  it('returns null instead of throwing when the store itself fails', async () => {
    const kv: KeyValueStore = {
      getItem: async () => {
        throw new Error('keychain locked');
      },
      setItem: async () => {},
      deleteItem: async () => {},
    };
    expect(await chunkedStorage(kv).getItem('k')).toBeNull();
  });

  it('removes every chunk and the count', async () => {
    const { kv, map } = memoryKv();
    const store = chunkedStorage(kv);
    await store.setItem('k', session);
    await store.removeItem('k');
    expect(map.size).toBe(0);
  });

  it('sweeps every possible chunk when the count is corrupt', async () => {
    const { kv, map } = memoryKv();
    map.set('k.n', 'garbage');
    map.set('k.0', 'a');
    map.set('k.5', 'b');
    await chunkedStorage(kv).removeItem('k');
    expect(map.size).toBe(0);
  });

  it('refuses a value too large to store rather than writing part of it', async () => {
    const { kv, map } = memoryKv();
    await expect(chunkedStorage(kv).setItem('k', 'x'.repeat(CHUNK_BYTES * 65))).rejects.toThrow();
    expect(map.size).toBe(0);
  });
});
