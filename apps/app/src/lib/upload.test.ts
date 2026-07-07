import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  MESH_UPLOAD_MAX_BYTES,
  MESHES_BUCKET,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  asUploadError,
  fileExtension,
  uploadScan,
  uploadScanWith,
  type UploadDeps,
} from './upload';

// The pure core uploadScanWith takes injected deps, so it runs in node with a
// fake supabase client and a fake file reader. No env vars are set, so the
// public uploadScan runs in fake mode (mirrors api.test.ts / the "zero backend
// configured" guarantee).

interface UploadCall {
  bucket: string;
  path: string;
  body: unknown;
  options: { upsert?: boolean; contentType?: string };
}
interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
  options: { onConflict?: string };
}
interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}

interface HarnessOptions {
  uploadResult?: Result<{ path: string }>;
  upsertResult?: Result<{ id: string }>;
  rpcResult?: Result<string>;
  getUserId?: () => Promise<string>;
  readFile?: UploadDeps['readFile'];
  newScanId?: () => string;
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const uploadCalls: UploadCall[] = [];
  const upsertCalls: UpsertCall[] = [];
  const rpcCalls: RpcCall[] = [];

  const uploadResult = options.uploadResult ?? { data: { path: 'p' }, error: null };
  const upsertResult = options.upsertResult ?? { data: { id: 'scan-1' }, error: null };
  const rpcResult = options.rpcResult ?? { data: 'job-1', error: null };

  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: unknown, opts: UploadCall['options']) => {
          order.push('upload');
          uploadCalls.push({ bucket, path, body, options: opts });
          return uploadResult;
        },
      }),
    },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: UpsertCall['options']) => {
        upsertCalls.push({ table, row, options: opts });
        return {
          select: () => ({
            single: async () => {
              order.push('upsert');
              return upsertResult;
            },
          }),
        };
      },
    }),
    rpc: async (name: string, params: Record<string, unknown>) => {
      order.push('rpc');
      rpcCalls.push({ name, params });
      return rpcResult;
    },
  } as unknown as SupabaseClient;

  const deps: UploadDeps = {
    client,
    getUserId:
      options.getUserId ??
      (async () => {
        order.push('getUserId');
        return 'user-1';
      }),
    readFile:
      options.readFile ??
      (async () => {
        order.push('readFile');
        return { size: 1234, body: new ArrayBuffer(8) };
      }),
    newScanId: options.newScanId ?? (() => 'scan-1'),
  };

  return { deps, order, uploadCalls, upsertCalls, rpcCalls };
}

describe('uploadScanWith: size cap', () => {
  it('rejects an oversize file before any network call', async () => {
    const h = harness({
      readFile: async () => ({ size: MESH_UPLOAD_MAX_BYTES + 1, body: new ArrayBuffer(1) }),
    });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_TOO_LARGE' });
    expect(h.uploadCalls).toHaveLength(0);
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('accepts a file exactly at the cap', async () => {
    const h = harness({
      readFile: async () => ({ size: MESH_UPLOAD_MAX_BYTES, body: new ArrayBuffer(1) }),
    });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).resolves.toMatchObject({ scanId: 'scan-1' });
  });
});

describe('uploadScanWith: path construction (must match storage RLS)', () => {
  it('uploads to ${userId}/${scanId}${ext} in the meshes bucket with upsert', async () => {
    const h = harness();
    await uploadScanWith(h.deps, { localFileUri: 'file:///captures/model.obj', leg: 'R' });
    expect(h.uploadCalls[0]?.bucket).toBe(MESHES_BUCKET);
    expect(h.uploadCalls[0]?.path).toBe('user-1/scan-1.obj');
    expect(h.uploadCalls[0]?.options.upsert).toBe(true);
  });

  it('preserves a usdz extension in the path', async () => {
    const h = harness();
    await uploadScanWith(h.deps, { localFileUri: 'file:///captures/model.USDZ', leg: 'L' });
    expect(h.uploadCalls[0]?.path).toBe('user-1/scan-1.usdz');
  });
});

describe('uploadScanWith: orchestration', () => {
  it('runs read -> user -> upload -> scan row -> enqueue in order', async () => {
    const h = harness();
    await uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' });
    expect(h.order).toEqual(['readFile', 'getUserId', 'upload', 'upsert', 'rpc']);
  });

  it('writes the scan row (status uploaded, owner, leg, path, meta) via upsert on id', async () => {
    const h = harness();
    await uploadScanWith(h.deps, {
      localFileUri: 'file:///m.obj',
      leg: 'L',
      captureMeta: { platform: 'ios', imageCount: 42 },
    });
    expect(h.upsertCalls[0]?.table).toBe('scans');
    expect(h.upsertCalls[0]?.row).toMatchObject({
      id: 'scan-1',
      user_id: 'user-1',
      leg: 'L',
      status: 'uploaded',
      mesh_path: 'user-1/scan-1.obj',
      capture_meta: { platform: 'ios', imageCount: 42 },
    });
    expect(h.upsertCalls[0]?.options.onConflict).toBe('id');
  });

  it('enqueues the measure job for the scan id via the RPC', async () => {
    const h = harness();
    await uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' });
    expect(h.rpcCalls[0]).toEqual({
      name: 'enqueue_measure_job',
      params: { p_scan_id: 'scan-1' },
    });
  });

  it('returns the scan id, mesh path, and job id', async () => {
    const h = harness();
    const res = await uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' });
    expect(res).toEqual({
      scanId: 'scan-1',
      meshPath: 'user-1/scan-1.obj',
      jobId: 'job-1',
      fake: false,
    });
  });
});

describe('uploadScanWith: failures', () => {
  it('no session: fails ERR_UPLOAD_NO_SESSION and never uploads', async () => {
    const h = harness({
      getUserId: async () => {
        throw new Error('not signed in');
      },
    });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_NO_SESSION' });
    expect(h.uploadCalls).toHaveLength(0);
  });

  it('storage error: fails ERR_UPLOAD_STORAGE and never writes the scan row', async () => {
    const h = harness({ uploadResult: { data: null, error: { message: 'boom' } } });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_STORAGE' });
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('db error: fails ERR_UPLOAD_DB and never enqueues', async () => {
    const h = harness({ upsertResult: { data: null, error: { message: 'db down' } } });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_DB' });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('enqueue error: fails ERR_UPLOAD_ENQUEUE', async () => {
    const h = harness({ rpcResult: { data: null, error: { message: 'no rpc' } } });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_ENQUEUE' });
  });

  it('read error: fails ERR_UPLOAD_READ before any network call', async () => {
    const h = harness({
      readFile: async () => {
        throw new Error('gone');
      },
    });
    await expect(
      uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_READ' });
    expect(h.uploadCalls).toHaveLength(0);
  });
});

describe('uploadScanWith: retry after partial failure', () => {
  it('reusing the scan id re-uploads the same object path and re-upserts the same row', async () => {
    // Attempt 1: upload ok, scan row insert fails.
    const first = harness({ upsertResult: { data: null, error: { message: 'db down' } } });
    await expect(
      uploadScanWith(first.deps, { localFileUri: 'file:///m.obj', leg: 'L' }),
    ).rejects.toMatchObject({ code: 'ERR_UPLOAD_DB' });
    const path = first.uploadCalls[0]?.path ?? '';
    const scanId = path.split('/')[1]?.replace('.obj', '') ?? '';
    expect(scanId).toBe('scan-1');

    // Attempt 2: same scan id -> same path, upsert overwrites, succeeds.
    const second = harness();
    const res = await uploadScanWith(second.deps, {
      localFileUri: 'file:///m.obj',
      leg: 'L',
      scanId,
    });
    expect(res.scanId).toBe(scanId);
    expect(second.uploadCalls[0]?.path).toBe('user-1/scan-1.obj');
    expect(second.uploadCalls[0]?.options.upsert).toBe(true);
    expect(second.upsertCalls[0]?.options.onConflict).toBe('id');
  });
});

describe('fileExtension', () => {
  it('lowercases and keeps the dot', () => {
    expect(fileExtension('file:///a/b/Model.OBJ')).toBe('.obj');
  });
  it('defaults to .obj when there is no extension', () => {
    expect(fileExtension('file:///a/b/model')).toBe('.obj');
  });
  it('ignores a query string', () => {
    expect(fileExtension('file:///a/model.usdz?token=1')).toBe('.usdz');
  });
});

describe('uploadScan: fake mode (no backend configured)', () => {
  it('returns a simulated success without a client', async () => {
    const res = await uploadScan({ localFileUri: 'file:///m.obj', leg: 'L' });
    expect(res.fake).toBe(true);
    expect(res.scanId).toBeTruthy();
    expect(res.meshPath).toContain(res.scanId);
    expect(res.meshPath).toContain('.obj');
    expect(res.jobId).toContain(res.scanId);
  });

  it('reuses a provided scan id in fake mode (retry idempotency)', async () => {
    const res = await uploadScan({ localFileUri: 'file:///m.obj', leg: 'R', scanId: 'fixed-id' });
    expect(res.scanId).toBe('fixed-id');
    expect(res.meshPath).toContain('fixed-id');
  });
});

describe('UploadError', () => {
  it('has a non-empty message for every code', () => {
    for (const [code, message] of Object.entries(UPLOAD_ERROR_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(0);
    }
  });

  it('asUploadError passes through an UploadError unchanged', () => {
    const original = new UploadError('ERR_UPLOAD_STORAGE', 'x');
    expect(asUploadError(original)).toBe(original);
  });

  it('asUploadError wraps an unknown value as ERR_UPLOAD_UNKNOWN', () => {
    const wrapped = asUploadError(new Error('surprise'));
    expect(wrapped).toBeInstanceOf(UploadError);
    expect(wrapped.code).toBe('ERR_UPLOAD_UNKNOWN');
  });
});
