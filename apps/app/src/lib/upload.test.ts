import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  MESH_UPLOAD_MAX_BYTES,
  MESHES_BUCKET,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  asUploadError,
  fileExtension,
  PHOTO_BUNDLE_LIMITS,
  PHOTO_UPLOAD_CONCURRENCY,
  mapWithConcurrency,
  toFileUri,
  uploadPhotoBundle,
  uploadPhotoBundleWith,
  uploadScan,
  uploadScanWith,
  validatePhotoManifest,
  SILHOUETTE_BUNDLE_LIMITS,
  uploadSilhouetteBundle,
  uploadSilhouetteBundleWith,
  validateSilhouetteManifest,
  type PhotoBundleDeps,
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

  it('stamps pair_id on the scan row and keeps it out of capture_meta', async () => {
    const h = harness();
    await uploadScanWith(h.deps, {
      localFileUri: 'file:///m.obj',
      leg: 'R',
      pairId: 'pair-1',
      captureMeta: { imageCount: 42 },
    });
    expect(h.upsertCalls[0]?.row).toMatchObject({ leg: 'R', pair_id: 'pair-1' });
    expect(h.upsertCalls[0]?.row.capture_meta).toEqual({ imageCount: 42 });
  });

  it('writes pair_id null when no pair is given', async () => {
    const h = harness();
    await uploadScanWith(h.deps, { localFileUri: 'file:///m.obj', leg: 'L' });
    expect(h.upsertCalls[0]?.row.pair_id).toBeNull();
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

// ---------------------------------------------------------------------------
// Photo bundle
// ---------------------------------------------------------------------------

function manifestImage(index: number) {
  return {
    file: `${String(index).padStart(3, '0')}.jpg`,
    timestamp: 10 + index * 0.25,
    camera_to_world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 1.2, -0.5, 1],
    intrinsics: [1400, 1400, 960, 720],
    width: 1920,
    height: 1440,
    tracking: 'normal',
  };
}

function manifest(imageCount = 24) {
  return {
    format: 'forms.photo-capture',
    version: 1,
    device: { model: 'iPhone17,3', os: '26.6.1' },
    images: Array.from({ length: imageCount }, (_, i) => manifestImage(i)),
  };
}

interface PhotoHarnessOptions extends HarnessOptions {
  manifestText?: string;
  readText?: PhotoBundleDeps['readText'];
}

function photoHarness(options: PhotoHarnessOptions = {}) {
  const h = harness({
    readFile:
      options.readFile ??
      (async () => ({ size: 500_000, body: new ArrayBuffer(8), contentType: 'image/jpeg' })),
    ...options,
  });
  const readUris: string[] = [];
  const baseRead = h.deps.readFile;
  const deps: PhotoBundleDeps = {
    ...h.deps,
    readFile: async (uri) => {
      readUris.push(uri);
      return baseRead(uri);
    },
    readText: options.readText ?? (async () => options.manifestText ?? JSON.stringify(manifest())),
  };
  return { ...h, deps, readUris };
}

const BUNDLE = { bundleDir: '/sandbox/photo-captures/s1', leg: 'L' as const };

describe('validatePhotoManifest', () => {
  it('accepts a contract-conforming manifest', () => {
    expect(validatePhotoManifest(manifest()).images).toHaveLength(24);
  });

  it('accepts a Finish anyway bundle: 20 images with finished_early true', () => {
    const early = {
      ...manifest(PHOTO_BUNDLE_LIMITS.minImages),
      capture: {
        mode: 'solo',
        anchor_world: [0, 0.3, -0.5],
        front_azimuth_rad: 1.2,
        coverage: 0.3,
        finished_early: true,
      },
    };
    expect(PHOTO_BUNDLE_LIMITS.minImages).toBe(20);
    expect(validatePhotoManifest(early).images).toHaveLength(20);
  });

  it('enforces the image count caps', () => {
    expect(() => validatePhotoManifest(manifest(PHOTO_BUNDLE_LIMITS.minImages - 1))).toThrow(
      /20 to 120/,
    );
    expect(() => validatePhotoManifest(manifest(PHOTO_BUNDLE_LIMITS.maxImages + 1))).toThrow(
      /20 to 120/,
    );
    expect(validatePhotoManifest(manifest(PHOTO_BUNDLE_LIMITS.minImages)).images).toHaveLength(20);
    expect(validatePhotoManifest(manifest(PHOTO_BUNDLE_LIMITS.maxImages)).images).toHaveLength(120);
  });

  it('rejects a wrong format, version, or device', () => {
    expect(() => validatePhotoManifest({ ...manifest(), format: 'other' })).toThrow(/format/);
    expect(() => validatePhotoManifest({ ...manifest(), version: 2 })).toThrow(/version/);
    expect(() => validatePhotoManifest({ ...manifest(), device: { model: 1 } })).toThrow(/device/);
    expect(() => validatePhotoManifest(null)).toThrow(/not an object/);
  });

  it.each([
    ['file not NNN.jpg', { file: '../x.jpg' }, /NNN\.jpg/],
    ['file with 4 digits', { file: '0001.jpg' }, /NNN\.jpg/],
    ['short pose', { camera_to_world: [1, 2, 3] }, /camera_to_world/],
    ['NaN in pose', { camera_to_world: Array(16).fill(Number.NaN) }, /camera_to_world/],
    ['3 intrinsics', { intrinsics: [1, 2, 3] }, /intrinsics/],
    ['oversize width', { width: 4032 }, /2048/],
    ['fractional height', { height: 10.5 }, /2048/],
    ['missing timestamp', { timestamp: 'now' }, /timestamp/],
    ['missing tracking', { tracking: undefined }, /tracking/],
  ])('rejects an image with %s', (_label, patch, pattern) => {
    const bad = manifest();
    bad.images[3] = { ...manifestImage(3), ...(patch as object) } as ReturnType<
      typeof manifestImage
    >;
    expect(() => validatePhotoManifest(bad)).toThrow(pattern);
  });

  it('rejects duplicate file names', () => {
    const bad = manifest();
    bad.images[5] = manifestImage(4);
    expect(() => validatePhotoManifest(bad)).toThrow(/duplicated/);
  });

  const CAPTURE_BLOCK = {
    mode: 'solo',
    anchor_world: [0.1, -0.4, -0.5],
    front_azimuth_rad: 1.57,
    coverage: 0.52,
    finished_early: false,
  };

  it('accepts the optional capture block and a manifest without it', () => {
    expect(validatePhotoManifest({ ...manifest(), capture: CAPTURE_BLOCK }).capture).toEqual(
      CAPTURE_BLOCK,
    );
    expect(
      validatePhotoManifest({ ...manifest(), capture: { ...CAPTURE_BLOCK, mode: 'helper' } }),
    ).toBeTruthy();
    expect(validatePhotoManifest(manifest()).capture).toBeUndefined();
  });

  it.each([
    ['not an object', [], /capture must be an object/],
    ['null', null, /capture must be an object/],
    ['an unknown key', { ...CAPTURE_BLOCK, extra: 1 }, /missing or unknown/],
    [
      'a missing key',
      Object.fromEntries(Object.entries(CAPTURE_BLOCK).filter(([k]) => k !== 'coverage')),
      /missing or unknown/,
    ],
    ['a bad mode', { ...CAPTURE_BLOCK, mode: 'tripod' }, /mode/],
    ['a 2-number anchor', { ...CAPTURE_BLOCK, anchor_world: [1, 2] }, /anchor_world/],
    ['a NaN anchor', { ...CAPTURE_BLOCK, anchor_world: [1, Number.NaN, 2] }, /anchor_world/],
    ['a string azimuth', { ...CAPTURE_BLOCK, front_azimuth_rad: '1' }, /front_azimuth_rad/],
    ['coverage above 1', { ...CAPTURE_BLOCK, coverage: 1.2 }, /coverage/],
    ['negative coverage', { ...CAPTURE_BLOCK, coverage: -0.1 }, /coverage/],
    ['NaN coverage', { ...CAPTURE_BLOCK, coverage: Number.NaN }, /coverage/],
    ['a numeric finished_early', { ...CAPTURE_BLOCK, finished_early: 0 }, /finished_early/],
  ])('rejects a capture block with %s', (_label, capture, pattern) => {
    expect(() => validatePhotoManifest({ ...manifest(), capture })).toThrow(pattern);
  });

  it('throws ERR_UPLOAD_INVALID_BUNDLE', () => {
    try {
      validatePhotoManifest({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UploadError);
      expect((error as UploadError).code).toBe('ERR_UPLOAD_INVALID_BUNDLE');
    }
  });
});

describe('uploadPhotoBundleWith: paths and ordering', () => {
  it('uploads every image then capture.json under ${userId}/${scanId}/ with upsert', async () => {
    const h = photoHarness();
    const res = await uploadPhotoBundleWith(h.deps, BUNDLE);
    const paths = h.uploadCalls.map((c) => c.path);
    expect(paths).toHaveLength(25);
    expect(new Set(paths.slice(0, 24))).toEqual(
      new Set(
        Array.from({ length: 24 }, (_, i) => `user-1/scan-1/images/${manifestImage(i).file}`),
      ),
    );
    expect(paths[24]).toBe('user-1/scan-1/capture.json');
    for (const call of h.uploadCalls) {
      expect(call.bucket).toBe(MESHES_BUCKET);
      expect(call.options.upsert).toBe(true);
      expect(call.path.startsWith('user-1/')).toBe(true);
    }
    expect(h.uploadCalls[0]?.options.contentType).toBe('image/jpeg');
    expect(h.uploadCalls[24]?.options.contentType).toBe('application/json');
    expect(res).toEqual({
      scanId: 'scan-1',
      bundlePath: 'user-1/scan-1',
      imageCount: 24,
      jobId: 'job-1',
      fake: false,
    });
  });

  it('reads images from file:// URIs inside the bundle dir', async () => {
    const h = photoHarness();
    await uploadPhotoBundleWith(h.deps, BUNDLE);
    expect(h.readUris[0]).toBe('file:///sandbox/photo-captures/s1/images/000.jpg');
  });

  it('runs user -> uploads -> scan row -> enqueue, manifest upload last among uploads', async () => {
    const h = photoHarness({ readFile: async () => ({ size: 10, body: new ArrayBuffer(1) }) });
    await uploadPhotoBundleWith(h.deps, BUNDLE);
    expect(h.order[0]).toBe('getUserId');
    expect(h.order.slice(1, 26).every((step) => step === 'upload')).toBe(true);
    expect(h.order.slice(26)).toEqual(['upsert', 'rpc']);
  });

  it('writes the scan row with capture_kind photos, null mesh_path, status uploaded', async () => {
    const h = photoHarness();
    await uploadPhotoBundleWith(h.deps, { ...BUNDLE, captureMeta: { imageCount: 24 } });
    expect(h.upsertCalls[0]?.table).toBe('scans');
    expect(h.upsertCalls[0]?.row).toEqual({
      id: 'scan-1',
      user_id: 'user-1',
      leg: 'L',
      status: 'uploaded',
      capture_kind: 'photos',
      mesh_path: null,
      pair_id: null,
      capture_meta: { imageCount: 24 },
    });
    expect(h.upsertCalls[0]?.options.onConflict).toBe('id');
    expect(h.rpcCalls[0]).toEqual({
      name: 'enqueue_measure_job',
      params: { p_scan_id: 'scan-1' },
    });
  });
});

describe('uploadPhotoBundleWith: caps and failures', () => {
  it('an invalid manifest fails before any network call', async () => {
    const h = photoHarness({ manifestText: JSON.stringify(manifest(5)) });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_INVALID_BUNDLE',
    });
    expect(h.order).toEqual([]);
  });

  it('malformed JSON fails as an invalid bundle', async () => {
    const h = photoHarness({ manifestText: '{not json' });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_INVALID_BUNDLE',
    });
  });

  it('an oversize capture.json is rejected before parsing', async () => {
    const h = photoHarness({
      manifestText: ' '.repeat(PHOTO_BUNDLE_LIMITS.maxManifestBytes + 1),
    });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toThrow(/bytes/);
    expect(h.uploadCalls).toHaveLength(0);
  });

  it('an unreadable capture.json fails ERR_UPLOAD_READ', async () => {
    const h = photoHarness({
      readText: async () => {
        throw new Error('gone');
      },
    });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_READ',
    });
  });

  it('an oversize JPEG fails ERR_UPLOAD_TOO_LARGE and never uploads the manifest or row', async () => {
    const h = photoHarness({
      readFile: async (uri) => ({
        size: uri.endsWith('/007.jpg') ? PHOTO_BUNDLE_LIMITS.maxImageBytes + 1 : 10,
        body: new ArrayBuffer(1),
      }),
    });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_TOO_LARGE',
    });
    expect(h.uploadCalls.some((c) => c.path.endsWith('capture.json'))).toBe(false);
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('a JPEG exactly at the cap is accepted', async () => {
    const h = photoHarness({
      readFile: async () => ({ size: PHOTO_BUNDLE_LIMITS.maxImageBytes, body: new ArrayBuffer(1) }),
    });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).resolves.toMatchObject({ imageCount: 24 });
  });

  it('a storage error fails ERR_UPLOAD_STORAGE without writing the row', async () => {
    const h = photoHarness({ uploadResult: { data: null, error: { message: 'boom' } } });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_STORAGE',
    });
    expect(h.upsertCalls).toHaveLength(0);
  });

  it('no session fails ERR_UPLOAD_NO_SESSION before reading any image', async () => {
    const h = photoHarness({
      getUserId: async () => {
        throw new Error('signed out');
      },
    });
    await expect(uploadPhotoBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_NO_SESSION',
    });
    expect(h.readUris).toHaveLength(0);
  });

  it('stamps pair_id on the scan row and keeps it out of capture_meta', async () => {
    const h = photoHarness();
    await uploadPhotoBundleWith(h.deps, {
      ...BUNDLE,
      leg: 'R',
      pairId: 'pair-1',
      captureMeta: { imageCount: 24 },
    });
    expect(h.upsertCalls[0]?.row).toMatchObject({ leg: 'R', pair_id: 'pair-1' });
    expect(h.upsertCalls[0]?.row.capture_meta).toEqual({ imageCount: 24 });
  });

  it('retrying with the same scan id hits the same paths and row', async () => {
    const first = photoHarness({ rpcResult: { data: null, error: { message: 'rpc down' } } });
    await expect(uploadPhotoBundleWith(first.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_ENQUEUE',
    });
    const second = photoHarness({ newScanId: () => 'other' });
    await uploadPhotoBundleWith(second.deps, { ...BUNDLE, scanId: 'scan-1' });
    expect(second.uploadCalls.map((c) => c.path).sort()).toEqual(
      first.uploadCalls.map((c) => c.path).sort(),
    );
    expect(second.upsertCalls[0]?.row.id).toBe('scan-1');
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and visits every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapWithConcurrency(
      Array.from({ length: 30 }, (_, i) => i),
      PHOTO_UPLOAD_CONCURRENCY,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(i);
        inFlight -= 1;
      },
    );
    expect(peak).toBe(PHOTO_UPLOAD_CONCURRENCY);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('stops starting new items after a failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 2, async (i) => {
        started.push(i);
        if (i === 1) {
          throw new Error('fail 1');
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }),
    ).rejects.toThrow('fail 1');
    expect(started.length).toBeLessThan(10);
  });

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
  });
});

describe('toFileUri', () => {
  it('prefixes a bare path and leaves a URI alone', () => {
    expect(toFileUri('/var/mobile/x.jpg')).toBe('file:///var/mobile/x.jpg');
    expect(toFileUri('file:///var/x.jpg')).toBe('file:///var/x.jpg');
  });
});

describe('uploadPhotoBundle: fake mode', () => {
  it('simulates success and reuses a provided scan id', async () => {
    const res = await uploadPhotoBundle({ ...BUNDLE, scanId: 'fixed' });
    expect(res).toMatchObject({ scanId: 'fixed', fake: true, jobId: 'fake-job-fixed' });
  });
});

// ---------------------------------------------------------------------------
// Silhouette bundle (capture.json v2)
// ---------------------------------------------------------------------------

const STATIONS = ['front', 'front_inner', 'inner', 'front_outer', 'outer'] as const;

function silhouetteImage(index: number) {
  const stem = String(index).padStart(3, '0');
  return { ...manifestImage(index), mask: `${stem}.png`, station: STATIONS[index] };
}

function silhouetteManifest(imageCount = 5) {
  return {
    format: 'forms.photo-capture',
    version: 2,
    method: 'silhouette',
    device: { model: 'iPhone17,3', os: '26.6.1' },
    capture: {
      mode: 'solo',
      anchor_world: [0.1, 0.25, -0.6],
      front_azimuth_rad: 1.57,
      coverage: imageCount / 5,
      finished_early: imageCount < 5,
    },
    floor_y: -0.02,
    images: Array.from({ length: imageCount }, (_, i) => silhouetteImage(i)),
  };
}

function silhouetteHarness(options: PhotoHarnessOptions = {}) {
  return photoHarness({ manifestText: JSON.stringify(silhouetteManifest()), ...options });
}

describe('validateSilhouetteManifest', () => {
  it('accepts a contract-conforming manifest, and floor_y null', () => {
    expect(validateSilhouetteManifest(silhouetteManifest()).images).toHaveLength(5);
    expect(validateSilhouetteManifest({ ...silhouetteManifest(), floor_y: null }).floor_y).toBe(
      null,
    );
  });

  it('accepts Finish with 4 and enforces 4..12 images', () => {
    expect(SILHOUETTE_BUNDLE_LIMITS.minImages).toBe(4);
    expect(validateSilhouetteManifest(silhouetteManifest(4)).capture.finished_early).toBe(true);
    expect(() => validateSilhouetteManifest(silhouetteManifest(3))).toThrow(/4 to 12/);
    const many = {
      ...silhouetteManifest(),
      images: Array.from({ length: 13 }, (_, i) => ({
        ...silhouetteImage(0),
        file: `${String(i).padStart(3, '0')}.jpg`,
        mask: `${String(i).padStart(3, '0')}.png`,
      })),
    };
    expect(() => validateSilhouetteManifest(many)).toThrow(/4 to 12/);
  });

  it('rejects v1, a wrong method, and a missing or bad floor_y', () => {
    expect(() => validateSilhouetteManifest(manifest())).toThrow(/version/);
    expect(() => validateSilhouetteManifest({ ...silhouetteManifest(), method: 'sweep' })).toThrow(
      /method/,
    );
    const { floor_y: _omit, ...noFloor } = silhouetteManifest();
    expect(() => validateSilhouetteManifest(noFloor)).toThrow(/floor_y/);
    expect(() => validateSilhouetteManifest({ ...silhouetteManifest(), floor_y: 'x' })).toThrow(
      /floor_y/,
    );
  });

  it('requires the capture block with exactly its keys', () => {
    const { capture: _omit, ...noCapture } = silhouetteManifest();
    expect(() => validateSilhouetteManifest(noCapture)).toThrow(/capture/);
    const extra = silhouetteManifest();
    expect(() =>
      validateSilhouetteManifest({ ...extra, capture: { ...extra.capture, leg: 'L' } }),
    ).toThrow(/unknown fields/);
  });

  it.each([
    [{ mask: '001.png' }, /mask must be 000.png/],
    [{ mask: '000.jpg' }, /mask/],
    [{ station: 'back' }, /station/],
    [{ file: '0.jpg' }, /NNN.jpg/],
    [{ camera_to_world: [1, 2] }, /camera_to_world/],
    [{ width: 4096 }, /2048/],
  ])('rejects a bad image field %o', (patch, pattern) => {
    const bad = silhouetteManifest();
    bad.images[0] = { ...bad.images[0], ...patch } as (typeof bad.images)[0];
    expect(() => validateSilhouetteManifest(bad)).toThrow(pattern);
  });

  it('accepts optional joints: absent, null, or [u, v, confidence] inside the image', () => {
    const ok = silhouetteManifest();
    ok.images[0] = { ...ok.images[0], joints: { knee: [960.5, 300, 0.8], ankle: null } } as never;
    ok.images[1] = { ...ok.images[1], joints: { knee: null, ankle: null } } as never;
    expect(validateSilhouetteManifest(ok).images[0]?.joints?.knee).toEqual([960.5, 300, 0.8]);
    expect(validateSilhouetteManifest(silhouetteManifest()).images[0]?.joints).toBeUndefined();
  });

  it.each([
    [{ knee: [1, 2, 0.5] }, /exactly knee and ankle/],
    [{ knee: null, ankle: null, hip: null }, /exactly knee and ankle/],
    [{ knee: [1, 2], ankle: null }, /3 numbers/],
    [{ knee: [2000, 2, 0.5], ankle: null }, /outside the image/],
    [{ knee: [1, -1, 0.5], ankle: null }, /outside the image/],
    [{ knee: null, ankle: [1, 1440.5, 0.5] }, /outside the image/],
    [{ knee: [1, 2, 1.5], ankle: null }, /confidence/],
    [[1, 2, 3], /object/],
  ])('rejects bad joints %o', (joints, pattern) => {
    const bad = silhouetteManifest();
    bad.images[0] = { ...bad.images[0], joints } as never;
    expect(() => validateSilhouetteManifest(bad)).toThrow(pattern);
  });

  it('rejects a station captured twice', () => {
    const bad = silhouetteManifest();
    bad.images[1] = { ...silhouetteImage(1), station: 'front' };
    expect(() => validateSilhouetteManifest(bad)).toThrow(/station is duplicated/);
  });
});

describe('uploadSilhouetteBundleWith', () => {
  it('uploads images and masks, then capture.json last, under ${userId}/${scanId}/', async () => {
    const h = silhouetteHarness();
    const res = await uploadSilhouetteBundleWith(h.deps, { ...BUNDLE, pairId: 'pair-1' });
    const paths = h.uploadCalls.map((c) => c.path);
    expect(paths).toHaveLength(11);
    const expected = Array.from({ length: 5 }, (_, i) => {
      const stem = String(i).padStart(3, '0');
      return [`user-1/scan-1/images/${stem}.jpg`, `user-1/scan-1/masks/${stem}.png`];
    }).flat();
    expect(new Set(paths.slice(0, 10))).toEqual(new Set(expected));
    expect(paths[10]).toBe('user-1/scan-1/capture.json');
    for (const call of h.uploadCalls) {
      expect(call.bucket).toBe(MESHES_BUCKET);
      expect(call.options.upsert).toBe(true);
    }
    const typeOf = (suffix: string) =>
      h.uploadCalls.find((c) => c.path.endsWith(suffix))?.options.contentType;
    expect(typeOf('000.jpg')).toBe('image/jpeg');
    expect(typeOf('000.png')).toBe('image/png');
    expect(typeOf('capture.json')).toBe('application/json');
    expect(h.readUris).toContain('file:///sandbox/photo-captures/s1/masks/004.png');
    expect(h.order.slice(-2)).toEqual(['upsert', 'rpc']);
    expect(h.upsertCalls[0]?.row).toMatchObject({
      capture_kind: 'photos',
      mesh_path: null,
      pair_id: 'pair-1',
      status: 'uploaded',
    });
    expect(h.rpcCalls[0]).toEqual({
      name: 'enqueue_measure_job',
      params: { p_scan_id: 'scan-1' },
    });
    expect(res).toMatchObject({ scanId: 'scan-1', bundlePath: 'user-1/scan-1', imageCount: 5 });
  });

  it('keeps at most PHOTO_UPLOAD_CONCURRENCY files in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = silhouetteHarness({
      readFile: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { size: 10, body: new ArrayBuffer(1) };
      },
    });
    await uploadSilhouetteBundleWith(h.deps, BUNDLE);
    expect(peak).toBeLessThanOrEqual(PHOTO_UPLOAD_CONCURRENCY);
  });

  it('an oversize mask fails ERR_UPLOAD_TOO_LARGE before the manifest or row', async () => {
    const h = silhouetteHarness({
      readFile: async (uri) => ({
        size: uri.endsWith('/002.png') ? SILHOUETTE_BUNDLE_LIMITS.maxMaskBytes + 1 : 10,
        body: new ArrayBuffer(1),
      }),
    });
    await expect(uploadSilhouetteBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_TOO_LARGE',
      message: expect.stringMatching(/^Mask/),
    });
    expect(h.uploadCalls.some((c) => c.path.endsWith('capture.json'))).toBe(false);
    expect(h.upsertCalls).toHaveLength(0);
  });

  it('an oversize JPEG fails at the 2 MB cap; a mask at exactly 1 MB passes', async () => {
    const big = silhouetteHarness({
      readFile: async (uri) => ({
        size: uri.endsWith('.jpg') ? SILHOUETTE_BUNDLE_LIMITS.maxImageBytes + 1 : 10,
        body: new ArrayBuffer(1),
      }),
    });
    await expect(uploadSilhouetteBundleWith(big.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_TOO_LARGE',
    });
    const exact = silhouetteHarness({
      readFile: async (uri) => ({
        size: uri.endsWith('.png') ? SILHOUETTE_BUNDLE_LIMITS.maxMaskBytes : 10,
        body: new ArrayBuffer(1),
      }),
    });
    await expect(uploadSilhouetteBundleWith(exact.deps, BUNDLE)).resolves.toMatchObject({
      imageCount: 5,
    });
  });

  it('an invalid or v1 manifest fails before any network call', async () => {
    const h = silhouetteHarness({ manifestText: JSON.stringify(manifest()) });
    await expect(uploadSilhouetteBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_INVALID_BUNDLE',
    });
    expect(h.order).toEqual([]);
  });

  it('an unreadable mask fails ERR_UPLOAD_READ', async () => {
    const h = silhouetteHarness({
      readFile: async (uri) => {
        if (uri.endsWith('.png')) {
          throw new Error('gone');
        }
        return { size: 10, body: new ArrayBuffer(1) };
      },
    });
    await expect(uploadSilhouetteBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_READ',
      message: 'Could not read a mask from the device.',
    });
  });

  it('retrying with the same scan id after an enqueue failure hits the same paths and row', async () => {
    const first = silhouetteHarness({ rpcResult: { data: null, error: { message: 'rpc down' } } });
    await expect(uploadSilhouetteBundleWith(first.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_ENQUEUE',
    });
    const second = silhouetteHarness({ newScanId: () => 'other' });
    await uploadSilhouetteBundleWith(second.deps, { ...BUNDLE, scanId: 'scan-1' });
    expect(second.uploadCalls.map((c) => c.path).sort()).toEqual(
      first.uploadCalls.map((c) => c.path).sort(),
    );
    expect(second.upsertCalls[0]?.row.id).toBe('scan-1');
  });

  it('a storage error on a mask fails ERR_UPLOAD_STORAGE without writing the row', async () => {
    const h = silhouetteHarness({ uploadResult: { data: null, error: { message: 'boom' } } });
    await expect(uploadSilhouetteBundleWith(h.deps, BUNDLE)).rejects.toMatchObject({
      code: 'ERR_UPLOAD_STORAGE',
    });
    expect(h.upsertCalls).toHaveLength(0);
  });
});

describe('uploadSilhouetteBundle: fake mode', () => {
  it('simulates success and reuses a provided scan id', async () => {
    const res = await uploadSilhouetteBundle({ ...BUNDLE, scanId: 'fixed' });
    expect(res).toMatchObject({ scanId: 'fixed', fake: true });
  });
});
