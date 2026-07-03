/**
 * Typed error surface for the capture module.
 *
 * Native (Swift) failures come back through expo-modules-core as coded errors.
 * We normalize every one of them into a {@link CaptureError} with a stable,
 * exhaustive {@link CaptureErrorCode} so app code can branch on the reason
 * (rescan, unsupported device, etc.) instead of string-matching messages.
 */

/** Stable machine-readable codes. Keep in sync with the Swift exception codes. */
export type CaptureErrorCode =
  /** Native module not present (web, Android, Simulator, Expo Go, non-LiDAR). */
  | 'ERR_CAPTURE_UNAVAILABLE'
  /** Device/OS cannot run ObjectCaptureSession even though the module loaded. */
  | 'ERR_CAPTURE_UNSUPPORTED_DEVICE'
  /** User backed out of the guided capture flow. */
  | 'ERR_CAPTURE_CANCELLED'
  /** Capture finished but produced too few usable images to reconstruct. */
  | 'ERR_CAPTURE_NO_IMAGES'
  /** PhotogrammetrySession failed to produce a model. */
  | 'ERR_RECONSTRUCTION_FAILED'
  /** USDZ produced, but the USDZ->OBJ (ModelIO) export failed. */
  | 'ERR_EXPORT_FAILED'
  /** Anything we could not classify. */
  | 'ERR_CAPTURE_UNKNOWN';

const KNOWN_CODES: ReadonlySet<string> = new Set<CaptureErrorCode>([
  'ERR_CAPTURE_UNAVAILABLE',
  'ERR_CAPTURE_UNSUPPORTED_DEVICE',
  'ERR_CAPTURE_CANCELLED',
  'ERR_CAPTURE_NO_IMAGES',
  'ERR_RECONSTRUCTION_FAILED',
  'ERR_EXPORT_FAILED',
  'ERR_CAPTURE_UNKNOWN',
]);

/** Base error for anything the capture module rejects with. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  /** The original native/thrown value, kept for debugging (never logged raw). */
  readonly cause?: unknown;

  constructor(code: CaptureErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.cause = cause;
    // Restore prototype chain for `instanceof` across the TS/Babel transpile
    // boundary (extending built-ins is lossy without this).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a capture function is called on a platform/build where the native
 * module is absent. This is the expected, non-crashing path on web, Android,
 * the iOS Simulator, and Expo Go.
 */
export class CaptureUnavailableError extends CaptureError {
  constructor(reason: string, cause?: unknown) {
    super('ERR_CAPTURE_UNAVAILABLE', reason, cause);
    this.name = 'CaptureUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Best-effort extraction of a `code` string from an unknown thrown value. */
function extractCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** Best-effort extraction of a human message from an unknown thrown value. */
function extractMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return undefined;
}

/**
 * Normalize any thrown value from the native side into a {@link CaptureError}.
 *
 * Order of preference:
 *   1. Already a CaptureError -> return as-is.
 *   2. `code` is one of our known stable codes -> use it directly.
 *   3. `code`/message contains a recognizable keyword -> best-effort map. This
 *      covers the case where expo-modules-core surfaces the Swift exception
 *      class name (e.g. "CaptureCancelledException") instead of our code.
 *   4. Otherwise -> ERR_CAPTURE_UNKNOWN.
 */
export function mapNativeError(error: unknown): CaptureError {
  if (error instanceof CaptureError) {
    return error;
  }

  const rawCode = extractCode(error);
  const message = extractMessage(error) ?? 'Unknown capture error.';

  if (rawCode && KNOWN_CODES.has(rawCode)) {
    return new CaptureError(rawCode as CaptureErrorCode, message, error);
  }

  const haystack = `${rawCode ?? ''} ${message}`.toLowerCase();
  if (/cancel/.test(haystack)) {
    return new CaptureError('ERR_CAPTURE_CANCELLED', message, error);
  }
  if (/unsupported|not supported|no lidar|lidar/.test(haystack)) {
    return new CaptureError('ERR_CAPTURE_UNSUPPORTED_DEVICE', message, error);
  }
  if (/no image|too few|empty/.test(haystack)) {
    return new CaptureError('ERR_CAPTURE_NO_IMAGES', message, error);
  }
  if (/export|obj|modelio|convert/.test(haystack)) {
    return new CaptureError('ERR_EXPORT_FAILED', message, error);
  }
  if (/reconstruct|photogrammetry|model/.test(haystack)) {
    return new CaptureError('ERR_RECONSTRUCTION_FAILED', message, error);
  }

  return new CaptureError('ERR_CAPTURE_UNKNOWN', message, error);
}
