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
import type { CaptureKind, ScanStatus } from '@forms/shared';

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
 * in @forms/shared: it is app-only today and promotion into the contract
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
  /** The photo bundle (capture.json + images) breaks the contract or caps. */
  | 'ERR_UPLOAD_INVALID_BUNDLE'
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
  ERR_UPLOAD_INVALID_BUNDLE:
    'The photos from this scan are incomplete or damaged, so they cannot be used. Scan again.',
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
  /** Two-leg capture session id, written to scans.pair_id. Both legs of a pair
   * carry the same id; (pair_id, leg) is unique server-side. */
  pairId?: string | null;
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
    pair_id: params.pairId ?? null,
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
// Photo bundle (non-LiDAR capture, reconstructed server-side)
// ---------------------------------------------------------------------------

const PHOTOS_CAPTURE_KIND: CaptureKind = 'photos';

/** Caps from the "forms.photo-capture" v1 contract. The server re-validates
 * every one; these exist so a bad bundle fails before any upload. */
export const PHOTO_BUNDLE_LIMITS = {
  minImages: 20,
  maxImages: 120,
  maxImageBytes: 2 * 1024 * 1024,
  maxLongSidePx: 2048,
  maxManifestBytes: 1024 * 1024,
} as const;

/** Image uploads in flight at once: bounds memory to a few JPEGs. */
export const PHOTO_UPLOAD_CONCURRENCY = 4;

const IMAGE_FILE_PATTERN = /^\d{3}\.jpg$/;

export interface PhotoManifestImage {
  file: string;
  timestamp: number;
  /** 16 numbers, column-major, meters, ARKit world (gravity -Y). */
  camera_to_world: number[];
  /** [fx, fy, cx, cy] at the written image size. */
  intrinsics: number[];
  width: number;
  height: number;
  tracking: string;
}

/** Optional capture v2 block. Exactly these keys: the server
 * (services/pipeline reconstruct/bundle.py) rejects missing or extra ones. */
export interface PhotoManifestCapture {
  mode: 'solo' | 'helper';
  /** Leg axis point, ARKit world meters (same frame as camera_to_world). */
  anchor_world: [number, number, number];
  /** atan2(camera.z - anchor.z, camera.x - anchor.x) at the aim tap. */
  front_azimuth_rad: number;
  /** 0..1, client-reported. */
  coverage: number;
  finished_early: boolean;
}

export interface PhotoManifest {
  format: 'forms.photo-capture';
  version: 1;
  device: { model: string; os: string };
  images: PhotoManifestImage[];
  capture?: PhotoManifestCapture;
}

const CAPTURE_KEYS = ['anchor_world', 'coverage', 'finished_early', 'front_azimuth_rad', 'mode'];

function validateCaptureBlock(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidBundle('capture must be an object');
  }
  const capture = value as Record<string, unknown>;
  if (Object.keys(capture).sort().join(',') !== CAPTURE_KEYS.join(',')) {
    throw invalidBundle('capture has missing or unknown fields');
  }
  if (capture.mode !== 'solo' && capture.mode !== 'helper') {
    throw invalidBundle('capture.mode must be solo or helper');
  }
  if (!isFiniteNumberArray(capture.anchor_world, 3)) {
    throw invalidBundle('capture.anchor_world must be 3 numbers');
  }
  if (
    typeof capture.front_azimuth_rad !== 'number' ||
    !Number.isFinite(capture.front_azimuth_rad)
  ) {
    throw invalidBundle('capture.front_azimuth_rad must be a number');
  }
  const coverage = capture.coverage;
  if (typeof coverage !== 'number' || !(coverage >= 0 && coverage <= 1)) {
    throw invalidBundle('capture.coverage must be between 0 and 1');
  }
  if (typeof capture.finished_early !== 'boolean') {
    throw invalidBundle('capture.finished_early must be a boolean');
  }
}

function invalidBundle(detail: string): UploadError {
  return new UploadError('ERR_UPLOAD_INVALID_BUNDLE', `Invalid photo bundle: ${detail}`);
}

function isFiniteNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;
}

function validateDevice(value: unknown): void {
  const device = value as Record<string, unknown> | null | undefined;
  if (
    typeof device !== 'object' ||
    device === null ||
    typeof device.model !== 'string' ||
    typeof device.os !== 'string'
  ) {
    throw invalidBundle('device must have string model and os');
  }
}

/** Per-image fields shared by v1 and v2. Returns the image as a record. */
function validateImageFields(
  raw: unknown,
  where: string,
  seen: Set<string>,
  maxLongSidePx: number,
): Record<string, unknown> {
  const image = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof image.file !== 'string' || !IMAGE_FILE_PATTERN.test(image.file)) {
    throw invalidBundle(`${where}.file must match NNN.jpg`);
  }
  if (seen.has(image.file)) {
    throw invalidBundle(`${where}.file is duplicated`);
  }
  seen.add(image.file);
  if (typeof image.timestamp !== 'number' || !Number.isFinite(image.timestamp)) {
    throw invalidBundle(`${where}.timestamp must be a number`);
  }
  if (!isFiniteNumberArray(image.camera_to_world, 16)) {
    throw invalidBundle(`${where}.camera_to_world must be 16 numbers`);
  }
  if (!isFiniteNumberArray(image.intrinsics, 4)) {
    throw invalidBundle(`${where}.intrinsics must be 4 numbers`);
  }
  if (!isPositiveInt(image.width, maxLongSidePx) || !isPositiveInt(image.height, maxLongSidePx)) {
    throw invalidBundle(`${where} size must be positive and at most ${maxLongSidePx} px`);
  }
  if (typeof image.tracking !== 'string') {
    throw invalidBundle(`${where}.tracking must be a string`);
  }
  return image;
}

/** Validate a parsed capture.json against the v1 contract and caps. Throws
 * ERR_UPLOAD_INVALID_BUNDLE naming the first violation. */
export function validatePhotoManifest(value: unknown): PhotoManifest {
  if (typeof value !== 'object' || value === null) {
    throw invalidBundle('capture.json is not an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== 'forms.photo-capture') {
    throw invalidBundle('unknown format');
  }
  if (manifest.version !== 1) {
    throw invalidBundle('unsupported version');
  }
  validateDevice(manifest.device);
  const images = manifest.images;
  if (!Array.isArray(images)) {
    throw invalidBundle('images must be an array');
  }
  const { minImages, maxImages, maxLongSidePx } = PHOTO_BUNDLE_LIMITS;
  if (images.length < minImages || images.length > maxImages) {
    throw invalidBundle(`expected ${minImages} to ${maxImages} images, got ${images.length}`);
  }
  const seen = new Set<string>();
  images.forEach((raw: unknown, index) => {
    validateImageFields(raw, `images[${index}]`, seen, maxLongSidePx);
  });
  if (manifest.capture !== undefined) {
    validateCaptureBlock(manifest.capture);
  }
  return value as PhotoManifest;
}

/** Caps from the "forms.photo-capture" v2 (silhouette) contract. minImages is
 * 4 because "Finish with 4" sends four stations. The server re-validates. */
export const SILHOUETTE_BUNDLE_LIMITS = {
  minImages: 4,
  maxImages: 12,
  maxImageBytes: 2 * 1024 * 1024,
  maxMaskBytes: 1024 * 1024,
  maxLongSidePx: 2048,
  maxManifestBytes: 1024 * 1024,
} as const;

export const SILHOUETTE_STATIONS = [
  'front',
  'front_inner',
  'inner',
  'front_outer',
  'outer',
] as const;
export type SilhouetteStationName = (typeof SILHOUETTE_STATIONS)[number];

/** [u, v, confidence]: pixels of the written image (u right, v down, origin
 * top-left, the mask's convention), confidence 0..1. */
export type SilhouetteJoint = [number, number, number];

export interface SilhouetteManifestImage extends PhotoManifestImage {
  /** NNN.png with the same NNN as file: 8-bit grayscale, same size, 255 = leg. */
  mask: string;
  station: SilhouetteStationName;
  /** Optional: Vision body pose for the captured leg; null when not seen. */
  joints?: { knee: SilhouetteJoint | null; ankle: SilhouetteJoint | null };
}

export interface SilhouetteManifest {
  format: 'forms.photo-capture';
  version: 2;
  method: 'silhouette';
  device: { model: string; os: string };
  capture: PhotoManifestCapture;
  /** World y of the floor plane (ARKit meters), or null when none was found. */
  floor_y: number | null;
  images: SilhouetteManifestImage[];
}

const JOINT_KEYS = ['ankle', 'knee'];

function validateJoints(value: unknown, where: string, width: number, height: number): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidBundle(`${where}.joints must be an object`);
  }
  const joints = value as Record<string, unknown>;
  if (Object.keys(joints).sort().join(',') !== JOINT_KEYS.join(',')) {
    throw invalidBundle(`${where}.joints must have exactly knee and ankle`);
  }
  for (const key of JOINT_KEYS) {
    const joint = joints[key];
    if (joint === null) {
      continue;
    }
    if (!isFiniteNumberArray(joint, 3)) {
      throw invalidBundle(`${where}.joints.${key} must be null or 3 numbers`);
    }
    const [u, v, confidence] = joint as [number, number, number];
    if (u < 0 || u > width || v < 0 || v > height) {
      throw invalidBundle(`${where}.joints.${key} is outside the image`);
    }
    if (confidence < 0 || confidence > 1) {
      throw invalidBundle(`${where}.joints.${key} confidence must be between 0 and 1`);
    }
  }
}

/** Validate a parsed capture.json against the v2 silhouette contract and caps.
 * Throws ERR_UPLOAD_INVALID_BUNDLE naming the first violation. */
export function validateSilhouetteManifest(value: unknown): SilhouetteManifest {
  if (typeof value !== 'object' || value === null) {
    throw invalidBundle('capture.json is not an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== 'forms.photo-capture') {
    throw invalidBundle('unknown format');
  }
  if (manifest.version !== 2) {
    throw invalidBundle('unsupported version');
  }
  if (manifest.method !== 'silhouette') {
    throw invalidBundle('method must be silhouette');
  }
  validateDevice(manifest.device);
  validateCaptureBlock(manifest.capture);
  const floorY = manifest.floor_y;
  if (floorY !== null && !(typeof floorY === 'number' && Number.isFinite(floorY))) {
    throw invalidBundle('floor_y must be a number or null');
  }
  const images = manifest.images;
  if (!Array.isArray(images)) {
    throw invalidBundle('images must be an array');
  }
  const { minImages, maxImages } = SILHOUETTE_BUNDLE_LIMITS;
  if (images.length < minImages || images.length > maxImages) {
    throw invalidBundle(`expected ${minImages} to ${maxImages} images, got ${images.length}`);
  }
  const seenFiles = new Set<string>();
  const seenStations = new Set<string>();
  images.forEach((raw: unknown, index) => {
    const where = `images[${index}]`;
    const image = validateImageFields(
      raw,
      where,
      seenFiles,
      SILHOUETTE_BUNDLE_LIMITS.maxLongSidePx,
    );
    const stem = (image.file as string).slice(0, 3);
    if (image.mask !== `${stem}.png`) {
      throw invalidBundle(`${where}.mask must be ${stem}.png`);
    }
    const station = image.station;
    if (
      typeof station !== 'string' ||
      !(SILHOUETTE_STATIONS as readonly string[]).includes(station)
    ) {
      throw invalidBundle(`${where}.station is not a known station`);
    }
    if (seenStations.has(station)) {
      throw invalidBundle(`${where}.station is duplicated`);
    }
    seenStations.add(station);
    if (image.joints !== undefined) {
      validateJoints(image.joints, where, image.width as number, image.height as number);
    }
  });
  return value as SilhouetteManifest;
}

/** Join a sandbox directory and a relative name into a file:// URI. */
export function bundleFileUri(dir: string, relative: string): string {
  return toFileUri(`${dir.replace(/\/+$/, '')}/${relative}`);
}

/** fetch() on React Native only reads local files through a file:// URI; the
 * native module returns bare absolute paths. */
export function toFileUri(pathOrUri: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(pathOrUri) ? pathOrUri : `file://${pathOrUri}`;
}

/** Run fn over items with at most `limit` in flight. Stops starting new items
 * after the first failure, waits for in-flight ones, then rethrows it. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) {
    throw (failure as { error: unknown }).error;
  }
}

export interface PhotoBundleDeps extends UploadDeps {
  /** Read a small local text file (capture.json). */
  readText(uri: string): Promise<string>;
}

export interface UploadPhotoBundleParams {
  /** Absolute bundle directory from startPhotoCapture (holds capture.json and
   * images/). */
  bundleDir: string;
  leg: Leg;
  captureMeta?: Record<string, unknown>;
  /** Reuse across retries: same object paths, same row, same active job. */
  scanId?: string;
  /** Same as UploadScanParams.pairId. */
  pairId?: string | null;
}

export interface UploadPhotoBundleResult {
  scanId: string;
  /** Storage prefix holding capture.json and images/ (`${userId}/${scanId}`). */
  bundlePath: string;
  imageCount: number;
  /** Id of the enqueued (or pre-existing) measurement job; null in fake mode. */
  jobId: string | null;
  fake: boolean;
}

/**
 * Orchestrate a photo bundle upload with injected dependencies. Order:
 *   1. read capture.json, cap its size, parse, validate (no network yet)
 *   2. resolve the user id (owner prefix)
 *   3. upload images/NNN.jpg, PHOTO_UPLOAD_CONCURRENCY at a time, each read,
 *      size-capped, and released before the next (upsert: retry-safe)
 *   4. upload capture.json LAST, so its presence implies every image landed
 *   5. upsert the scan row (capture_kind photos, mesh_path null)
 *   6. enqueue the measurement job
 *
 * Same retry contract as uploadScanWith: pass params.scanId to re-run in place.
 */
export async function uploadPhotoBundleWith(
  deps: PhotoBundleDeps,
  params: UploadPhotoBundleParams,
): Promise<UploadPhotoBundleResult> {
  const manifestText = await readManifestText(deps, params, PHOTO_BUNDLE_LIMITS.maxManifestBytes);
  const manifest = validatePhotoManifest(parseManifest(manifestText));
  const files: BundleFile[] = manifest.images.map((image) => ({
    relative: `images/${image.file}`,
    maxBytes: PHOTO_BUNDLE_LIMITS.maxImageBytes,
    contentType: 'image/jpeg',
    kind: 'photo',
  }));
  return uploadBundleFiles(deps, params, manifestText, files, manifest.images.length);
}

/**
 * Silhouette (capture.json v2) counterpart of uploadPhotoBundleWith: the same
 * order and retry contract, with each image's mask (masks/NNN.png) uploaded
 * alongside the images under the same concurrency bound, capture.json still
 * last.
 */
export async function uploadSilhouetteBundleWith(
  deps: PhotoBundleDeps,
  params: UploadPhotoBundleParams,
): Promise<UploadPhotoBundleResult> {
  const manifestText = await readManifestText(
    deps,
    params,
    SILHOUETTE_BUNDLE_LIMITS.maxManifestBytes,
  );
  const manifest = validateSilhouetteManifest(parseManifest(manifestText));
  const files: BundleFile[] = manifest.images.flatMap((image): BundleFile[] => [
    {
      relative: `images/${image.file}`,
      maxBytes: SILHOUETTE_BUNDLE_LIMITS.maxImageBytes,
      contentType: 'image/jpeg',
      kind: 'photo',
    },
    {
      relative: `masks/${image.mask}`,
      maxBytes: SILHOUETTE_BUNDLE_LIMITS.maxMaskBytes,
      contentType: 'image/png',
      kind: 'mask',
    },
  ]);
  return uploadBundleFiles(deps, params, manifestText, files, manifest.images.length);
}

/** One bundle file, relative to both the local bundle dir and the storage prefix. */
interface BundleFile {
  relative: string;
  maxBytes: number;
  contentType: string;
  kind: 'photo' | 'mask';
}

async function readManifestText(
  deps: PhotoBundleDeps,
  params: UploadPhotoBundleParams,
  maxBytes: number,
): Promise<string> {
  if (params.leg !== 'L' && params.leg !== 'R') {
    throw new UploadError('ERR_UPLOAD_UNKNOWN', `Invalid leg: ${String(params.leg)}`);
  }
  let manifestText: string;
  try {
    manifestText = await deps.readText(bundleFileUri(params.bundleDir, 'capture.json'));
  } catch (error) {
    throw new UploadError('ERR_UPLOAD_READ', 'Could not read capture.json from the device.', error);
  }
  const manifestBytes = new TextEncoder().encode(manifestText).length;
  if (manifestBytes > maxBytes) {
    throw invalidBundle(`capture.json is ${manifestBytes} bytes`);
  }
  return manifestText;
}

function parseManifest(manifestText: string): unknown {
  try {
    return JSON.parse(manifestText);
  } catch {
    throw invalidBundle('capture.json is not valid JSON');
  }
}

/** Steps 2 to 6 shared by both bundle formats. */
async function uploadBundleFiles(
  deps: PhotoBundleDeps,
  params: UploadPhotoBundleParams,
  manifestText: string,
  files: readonly BundleFile[],
  imageCount: number,
): Promise<UploadPhotoBundleResult> {
  // 2. Owner prefix (storage RLS requires `${auth.uid()}/`).
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
  const bundlePath = `${userId}/${scanId}`;
  const bucket = deps.client.storage.from(MESHES_BUCKET);

  // 3. Files, bounded concurrency.
  await mapWithConcurrency(files, PHOTO_UPLOAD_CONCURRENCY, async (entry) => {
    const noun = entry.kind === 'photo' ? 'Photo' : 'Mask';
    let file: UploadFile;
    try {
      file = await deps.readFile(bundleFileUri(params.bundleDir, entry.relative));
    } catch (error) {
      throw new UploadError(
        'ERR_UPLOAD_READ',
        `Could not read a ${entry.kind} from the device.`,
        error,
      );
    }
    if (file.size > entry.maxBytes) {
      throw new UploadError(
        'ERR_UPLOAD_TOO_LARGE',
        `${noun} is ${file.size} bytes, over the ${entry.maxBytes} byte limit.`,
      );
    }
    const uploaded = await bucket.upload(`${bundlePath}/${entry.relative}`, file.body, {
      contentType: entry.contentType,
      upsert: true,
    });
    if (uploaded.error) {
      throw new UploadError(
        'ERR_UPLOAD_STORAGE',
        `Failed to upload a ${entry.kind}.`,
        uploaded.error,
      );
    }
  });

  // 4. Manifest last.
  const manifestUploaded = await bucket.upload(`${bundlePath}/capture.json`, manifestText, {
    contentType: 'application/json',
    upsert: true,
  });
  if (manifestUploaded.error) {
    throw new UploadError(
      'ERR_UPLOAD_STORAGE',
      'Failed to upload capture.json.',
      manifestUploaded.error,
    );
  }

  // 5. Scan row, same upsert semantics as the mesh path.
  const scanRow = {
    id: scanId,
    user_id: userId,
    leg: params.leg,
    status: UPLOADED_STATUS,
    capture_kind: PHOTOS_CAPTURE_KIND,
    mesh_path: null,
    pair_id: params.pairId ?? null,
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

  // 6. Enqueue.
  const enqueued = await deps.client.rpc('enqueue_measure_job', { p_scan_id: scanId });
  if (enqueued.error) {
    throw new UploadError(
      'ERR_UPLOAD_ENQUEUE',
      'Failed to queue the scan for measurement.',
      enqueued.error,
    );
  }

  const jobId = typeof enqueued.data === 'string' ? enqueued.data : null;
  return { scanId, bundlePath, imageCount, jobId, fake: false };
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
      const response = await fetch(toFileUri(uri));
      const body = await response.blob();
      return { size: body.size, body, contentType: body.type || undefined };
    },
    newScanId,
  };
}

function defaultPhotoBundleDeps(): PhotoBundleDeps {
  return {
    ...defaultUploadDeps(),
    async readText(uri) {
      const response = await fetch(toFileUri(uri));
      return response.text();
    },
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

/** FAKE MODE for photo and silhouette bundles: same contract as simulateUpload. */
async function simulatePhotoBundleUpload(
  params: UploadPhotoBundleParams,
): Promise<UploadPhotoBundleResult> {
  const scanId = params.scanId ?? randomUuid();
  return {
    scanId,
    bundlePath: `fake/${scanId}`,
    imageCount: 0,
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

/** Upload a silhouette bundle (capture.json v2): images, masks, capture.json,
 * scan row, job. Simulated success in fake mode, like uploadPhotoBundle. */
export async function uploadSilhouetteBundle(
  params: UploadPhotoBundleParams,
): Promise<UploadPhotoBundleResult> {
  if (USE_FAKE_DATA) {
    return simulatePhotoBundleUpload(params);
  }
  return uploadSilhouetteBundleWith(defaultPhotoBundleDeps(), params);
}

/** Upload a photo bundle: images + capture.json to storage, scan row, job.
 * Simulated success in fake mode, like uploadScan. */
export async function uploadPhotoBundle(
  params: UploadPhotoBundleParams,
): Promise<UploadPhotoBundleResult> {
  if (USE_FAKE_DATA) {
    return simulatePhotoBundleUpload(params);
  }
  return uploadPhotoBundleWith(defaultPhotoBundleDeps(), params);
}
