/**
 * Scan upload path (ROADMAP.md week 6). After a capture reconstructs to a local
 * OBJ, this module: (1) reads the file and enforces a client-side size cap that
 * mirrors the pipeline's mesh cap, (2) uploads it to the private `meshes` bucket
 * under the owner-scoped path the storage RLS policy expects, (3) inserts the
 * scan row, and (4) enqueues the measurement job.
 *
 * Design notes (apps/app/CLAUDE.md "Upload path reasoning"):
 * - The meshes bucket is private with owner-scoped paths. Storage RLS
 *   (supabase/migrations/0003_storage.sql) requires the object name to start
 *   with `${auth.uid()}/`, so the path is `${userId}/${scanId}${ext}`. We follow
 *   that policy exactly; we do not invent a path convention.
 * - Enqueueing goes through a SECURITY DEFINER RPC (enqueue_measure_job,
 *   migration 0007) that re-checks ownership and status server-side. The
 *   client's word is never trusted; the checks the UI happens to do here are a
 *   fast-fail convenience, not the security boundary.
 * - Fake/offline mode: with no EXPO_PUBLIC_SUPABASE_* env, this returns a
 *   simulated success so the capture flow's happy path renders in local dev and
 *   CI with zero backend (same guarantee as src/lib/api.ts). See simulateUpload.
 *
 * The core is a pure function, uploadScanWith(deps, params), with every I/O
 * dependency injected, so orchestration order, the size cap, path construction,
 * and retry behavior are all unit-testable in node without a device (see
 * upload.test.ts). uploadScan() is the thin real-deps / fake-mode wrapper.
 *
 * Sensitive-data note (CLAUDE.md gotcha 5): meshes are body scans of (often)
 * minors. Nothing here logs the file, the path, or any scan content, and the
 * upload uses the user's own RLS-scoped session (no service key exists in this
 * bundle).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanStatus } from '@zells/shared';

import { getSupabaseClient, hasSupabaseConfig } from './supabase';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Client-side mesh size cap in bytes. Mirrors the `meshes` bucket
 * file_size_limit (104857600 = 100 MB, supabase/migrations/0003_storage.sql)
 * and the pipeline's mesh cap, so an oversize scan fails fast on-device before
 * any upload bandwidth is spent instead of being rejected by storage or the
 * worker after a long transfer.
 */
export const MESH_UPLOAD_MAX_BYTES = 104_857_600;

/** The private bucket raw scan meshes are uploaded to. */
export const MESHES_BUCKET = 'meshes';

/** Scan status written on a completed upload. Typed against the shared enum so
 * a stray string literal is a compile error (apps/app/CLAUDE.md data-layer
 * conventions: the SQL state machine is the authority, shared enums its
 * projection). */
const UPLOADED_STATUS: ScanStatus = 'uploaded';

const USE_FAKE_DATA = !hasSupabaseConfig();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which leg the scan is of. Matches the scans.leg CHECK constraint
 * ('L','R') in supabase/migrations/0001_schema.sql. Defined locally rather than
 * in @zells/shared: it is app-only today and promotion into the contract
 * package is cheap later (packages/shared/CLAUDE.md: keep single-consumer
 * things in the app). */
export type Leg = 'L' | 'R';

export type UploadErrorCode =
  /** File is larger than MESH_UPLOAD_MAX_BYTES; rejected before any upload. */
  | 'ERR_UPLOAD_TOO_LARGE'
  /** The local scan file could not be read off the device. */
  | 'ERR_UPLOAD_READ'
  /** No signed-in user, so there is no owner prefix to upload into. */
  | 'ERR_UPLOAD_NO_SESSION'
  /** Storage upload failed (network, RLS, quota). */
  | 'ERR_UPLOAD_STORAGE'
  /** Inserting the scan row failed. */
  | 'ERR_UPLOAD_DB'
  /** Enqueuing the measurement job failed. */
  | 'ERR_UPLOAD_ENQUEUE'
  /** Anything not classified above. */
  | 'ERR_UPLOAD_UNKNOWN';

/** Error for anything the upload path rejects with. Carries a stable code so
 * the UI can branch (retry vs rescan) without string-matching. */
export class UploadError extends Error {
  readonly code: UploadErrorCode;
  /** Original thrown value, kept for debugging. Never logged raw (may hint at
   * scan content / paths). */
  readonly cause?: unknown;

  constructor(code: UploadErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.cause = cause;
    // Restore prototype chain for `instanceof` across the transpile boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Plain-language message per code, written for the person holding the phone. */
export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  ERR_UPLOAD_TOO_LARGE:
    'This scan is too large to upload. Scan again at a lower detail level and try once more.',
  ERR_UPLOAD_READ: 'The scan file could not be read from this phone. Run the scan again.',
  ERR_UPLOAD_NO_SESSION: 'You need to be signed in to save a scan. Sign in and try again.',
  ERR_UPLOAD_STORAGE: 'The scan could not be uploaded. Check your connection and tap Retry.',
  ERR_UPLOAD_DB: 'The scan uploaded but could not be saved to your library. Tap Retry.',
  ERR_UPLOAD_ENQUEUE: 'The scan was saved but could not be queued for measurement. Tap Retry.',
  ERR_UPLOAD_UNKNOWN: 'Something went wrong saving the scan. Tap Retry.',
};

/** Map an upload error to its user-facing message. */
export function uploadErrorMessage(error: UploadError): string {
  return UPLOAD_ERROR_MESSAGES[error.code];
}

/** Normalize any thrown value into an UploadError. */
export function asUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'Unknown upload error.';
  return new UploadError('ERR_UPLOAD_UNKNOWN', message, error);
}

export interface UploadScanParams {
  /** Absolute local URI of the reconstructed mesh (OBJ), from the capture flow. */
  localFileUri: string;
  /** Which leg this scan is of. */
  leg: Leg;
  /** Free-form capture metadata (device, os, duration, session). Never used for
   * measurement logic; stored on the scan row for debugging/analytics. */
  captureMeta?: Record<string, unknown>;
  /** Reuse a scan id across retries so a partial failure is idempotent: the
   * same object path, the same scan row (upsert), and the same active job
   * (guarded server-side). Omit on the first attempt. */
  scanId?: string;
}

export interface UploadScanResult {
  scanId: string;
  meshPath: string;
  /** Id of the enqueued (or pre-existing) measurement job; null in fake mode. */
  jobId: string | null;
  /** True when produced by fake mode (no backend configured). */
  fake: boolean;
}

/** A local file read into memory, plus its size for the pre-upload cap check. */
export interface UploadFile {
  size: number;
  body: Blob | ArrayBuffer;
  contentType?: string;
}

/** Everything the pure core touches outside itself. */
export interface UploadDeps {
  client: SupabaseClient;
  /** Resolve the signed-in user's id (throws UploadError ERR_UPLOAD_NO_SESSION
   * if absent). Used only to build the owner-scoped storage path and scan row;
   * RLS re-enforces ownership regardless. */
  getUserId(): Promise<string>;
  /** Read the local file into memory. */
  readFile(uri: string): Promise<UploadFile>;
  /** Generate a fresh scan id (a UUID) when the caller did not supply one. */
  newScanId(): string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Lowercased file extension including the dot, defaulting to '.obj' (the
 * pipeline's expected mesh format, CLAUDE.md gotcha 4). */
export function fileExtension(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const base = withoutQuery.substring(withoutQuery.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.substring(dot).toLowerCase() : '.obj';
}

/** Best-effort content type for a mesh extension. Not security-relevant (the
 * bucket accepts any type and the worker does real validation, 0003_storage.sql),
 * just a helpful hint on the stored object. */
function contentTypeFor(ext: string): string {
  switch (ext) {
    case '.obj':
      return 'model/obj';
    case '.usdz':
      return 'model/vnd.usdz+zip';
    case '.glb':
      return 'model/gltf-binary';
    default:
      return 'application/octet-stream';
  }
}

/** Generate a fresh scan id (UUID). Exported so a caller that needs the id
 * before upload (the capture flow, to keep retries idempotent by reusing the
 * same id) can allocate it up front and pass it back in via params.scanId. */
export function newScanId(): string {
  return randomUuid();
}

/** RFC4122-ish v4 UUID. Prefers crypto.randomUUID; falls back to a
 * Math.random variant, which is acceptable strength for a storage object key
 * (uniqueness, not secrecy). Avoids adding expo-crypto as a dependency. */
function randomUuid(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Orchestrate the upload with injected dependencies. Order:
 *   1. read the file and enforce the size cap (no network yet)
 *   2. resolve the user id (owner prefix)
 *   3. upload to meshes/${userId}/${scanId}${ext} (upsert: retry-safe)
 *   4. upsert the scan row (idempotent on id)
 *   5. enqueue the measurement job (server-side ownership + duplicate guard)
 *
 * Retry-after-partial-failure: pass params.scanId to reuse the same id, so step
 * 3 overwrites, step 4 updates in place, and step 5 returns the existing active
 * job rather than creating a duplicate.
 */
export async function uploadScanWith(
  deps: UploadDeps,
  params: UploadScanParams,
): Promise<UploadScanResult> {
  if (params.leg !== 'L' && params.leg !== 'R') {
    throw new UploadError('ERR_UPLOAD_UNKNOWN', `Invalid leg: ${String(params.leg)}`);
  }

  // 1. Read locally and cap BEFORE any network call.
  let file: UploadFile;
  try {
    file = await deps.readFile(params.localFileUri);
  } catch (error) {
    throw new UploadError(
      'ERR_UPLOAD_READ',
      'Could not read the scan file from the device.',
      error,
    );
  }
  if (file.size > MESH_UPLOAD_MAX_BYTES) {
    throw new UploadError(
      'ERR_UPLOAD_TOO_LARGE',
      `Scan is ${file.size} bytes, over the ${MESH_UPLOAD_MAX_BYTES} byte limit.`,
    );
  }

  // 2. Resolve the owner. The path MUST live under this prefix (0003_storage.sql).
  let userId: string;
  try {
    userId = await deps.getUserId();
  } catch (error) {
    throw new UploadError('ERR_UPLOAD_NO_SESSION', 'You must be signed in to save a scan.', error);
  }
  if (!userId) {
    throw new UploadError('ERR_UPLOAD_NO_SESSION', 'You must be signed in to save a scan.');
  }

  const scanId = params.scanId ?? deps.newScanId();
  const ext = fileExtension(params.localFileUri);
  // Exactly the convention the storage RLS "meshes: insert own prefix" policy
  // enforces: name LIKE auth.uid() || '/%'.
  const meshPath = `${userId}/${scanId}${ext}`;

  // 3. Upload. upsert:true so retrying after a partial failure overwrites the
  // same object instead of failing on a duplicate.
  const uploaded = await deps.client.storage.from(MESHES_BUCKET).upload(meshPath, file.body, {
    contentType: file.contentType ?? contentTypeFor(ext),
    upsert: true,
  });
  if (uploaded.error) {
    throw new UploadError('ERR_UPLOAD_STORAGE', 'Failed to upload the scan mesh.', uploaded.error);
  }

  // 4. Upsert the scan row. Idempotent on id so a retry updates in place; RLS
  // "scans: insert/update own" requires user_id = auth.uid(), set here.
  const scanRow = {
    id: scanId,
    user_id: userId,
    leg: params.leg,
    status: UPLOADED_STATUS,
    mesh_path: meshPath,
    capture_meta: params.captureMeta ?? null,
  };
  const inserted = await deps.client
    .from('scans')
    .upsert(scanRow, { onConflict: 'id' })
    .select('id')
    .single();
  if (inserted.error) {
    throw new UploadError(
      'ERR_UPLOAD_DB',
      'Failed to save the scan to your library.',
      inserted.error,
    );
  }

  // 5. Enqueue the measurement job via the SECURITY DEFINER RPC. It re-checks
  // ownership + uploaded status and returns an existing active job id instead of
  // duplicating, so this is safe to call again on retry.
  const enqueued = await deps.client.rpc('enqueue_measure_job', { p_scan_id: scanId });
  if (enqueued.error) {
    throw new UploadError(
      'ERR_UPLOAD_ENQUEUE',
      'Failed to queue the scan for measurement.',
      enqueued.error,
    );
  }

  const jobId = typeof enqueued.data === 'string' ? enqueued.data : null;
  return { scanId, meshPath, jobId, fake: false };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

function defaultUploadDeps(): UploadDeps {
  const client = getSupabaseClient();
  return {
    client,
    async getUserId() {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) {
        throw new UploadError(
          'ERR_UPLOAD_NO_SESSION',
          'You must be signed in to save a scan.',
          error,
        );
      }
      return data.user.id;
    },
    async readFile(uri) {
      // fetch handles file:// URIs in React Native (and blob: on web), so no
      // extra dependency (expo-file-system) is needed just to read the bytes.
      //
      // TODO(roadmap week 6): Draco/zip compression before upload. Compress the
      // OBJ here once a dependency-light path exists, or have the native module
      // zip the OBJ and hand back the archive path. Raw upload for now.
      //
      // Tradeoff: fetch().blob() loads the whole mesh into memory. supabase-js
      // has no streaming upload on React Native, and the size cap bounds this to
      // <=100 MB, so it is acceptable for Phase 0; revisit with the compression
      // step above.
      const response = await fetch(uri);
      const body = await response.blob();
      return { size: body.size, body, contentType: body.type || undefined };
    },
    newScanId,
  };
}

// ---------------------------------------------------------------------------
// Fake mode
// ---------------------------------------------------------------------------

/**
 * FAKE MODE: no backend configured (see src/lib/supabase.ts and src/lib/api.ts).
 * Return a simulated success in the real shape so the capture flow's upload ->
 * success path runs in local dev and CI with zero credentials. No file is read
 * and no network is touched: the point is a code-obvious, clearly-marked branch,
 * not a real transfer.
 */
async function simulateUpload(params: UploadScanParams): Promise<UploadScanResult> {
  const scanId = params.scanId ?? randomUuid();
  const ext = fileExtension(params.localFileUri);
  return {
    scanId,
    meshPath: `fake/${scanId}${ext}`,
    jobId: `fake-job-${scanId}`,
    fake: true,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Upload a completed scan: mesh to storage, scan row, measurement job. Uses the
 * real Supabase client when configured, or a simulated success in fake mode.
 * The capture flow (src/hooks/useCaptureFlow.ts) calls this and does not care
 * which branch ran.
 */
export async function uploadScan(params: UploadScanParams): Promise<UploadScanResult> {
  if (USE_FAKE_DATA) {
    return simulateUpload(params);
  }
  return uploadScanWith(defaultUploadDeps(), params);
}
