/**
 * Catalog photo upload rules. Pure: type sniffing by magic bytes, header
 * level dimension parsing for JPEG, PNG and WebP (no image dependency), the
 * size and dimension caps, server-side path generation, alt text, and the
 * same-origin check for the upload route. Every upload is untrusted input:
 * the declared Content-Type and the client's filename are never believed.
 */

import { isUuid } from './ids';
import type { ParseResult } from './shop';

/** Mirrors the bucket file_size_limit (0023). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Per side. Bounds decode memory for anything that later renders the file. */
export const MAX_IMAGE_DIMENSION = 6000;
/** Bounds every gallery read and the reorder renumbering. */
export const MAX_IMAGES_PER_PRODUCT = 12;
export const MAX_ALT_TEXT = 200;
/** Custom header the upload route requires: forms cannot set it, so a
 * cross-site form post never reaches the handler (CSRF). */
export const UPLOAD_HEADER = 'x-forms-admin-upload';

export type ImageKind = 'jpeg' | 'png' | 'webp';

export const IMAGE_KIND_META: Record<ImageKind, { contentType: string; ext: string }> = {
  jpeg: { contentType: 'image/jpeg', ext: 'jpg' },
  png: { contentType: 'image/png', ext: 'png' },
  webp: { contentType: 'image/webp', ext: 'webp' },
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) {
    return false;
  }
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return '';
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The real type from the first bytes, or null for anything else. */
export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'png';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'webp';
  }
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function pngDimensions(b: Uint8Array): Dimensions | null {
  // IHDR must be the first chunk: length 13 at 8, type at 12, w/h at 16/20.
  if (b.length < 24 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') {
    return null;
  }
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

// Start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and CC
// (DAC) share the range but are not frames.
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(b: Uint8Array): Dimensions | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      return null;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1; // fill byte
      continue;
    }
    // Standalone markers (TEM, RSTn) have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    // Scan data or end of image before any frame header: no dimensions.
    if (marker === 0xda || marker === 0xd9) {
      return null;
    }
    const length = u16be(b, o + 2);
    if (length < 2) {
      return null;
    }
    if (JPEG_SOF.has(marker)) {
      if (o + 9 > b.length || length < 7) {
        return null;
      }
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + length;
  }
  return null;
}

function webpDimensions(b: Uint8Array): Dimensions | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: keyframe start code 9d 01 2a, then 14-bit width and height.
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) {
      return null;
    }
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f, then 14-bit (width - 1) and (height - 1).
    if (b.length < 25 || b[20] !== 0x2f) {
      return null;
    }
    const b1 = b[21]!;
    const b2 = b[22]!;
    const b3 = b[23]!;
    const b4 = b[24]!;
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit (canvas width - 1) at 24 and (height - 1) at 27.
    if (b.length < 30) {
      return null;
    }
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

/** Dimensions from the header, or null when it does not parse. */
export function readImageDimensions(bytes: Uint8Array, kind: ImageKind): Dimensions | null {
  if (kind === 'png') {
    return pngDimensions(bytes);
  }
  if (kind === 'jpeg') {
    return jpegDimensions(bytes);
  }
  return webpDimensions(bytes);
}

export interface ValidImage extends Dimensions {
  kind: ImageKind;
  contentType: string;
  ext: string;
  bytes: number;
}

/**
 * Every check an uploaded file must pass. `declaredType` (the request's
 * Content-Type) must be an allowed type AND agree with the sniffed bytes, so
 * a renamed file or a polyglot claiming to be something else is refused.
 */
export function validateImageUpload(
  bytes: Uint8Array,
  declaredType: string | null,
): ParseResult<ValidImage> {
  if (bytes.length === 0) {
    return { ok: false, errors: ['The file is empty.'] };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, errors: ['The file is larger than 5 MB.'] };
  }
  const kind = sniffImageKind(bytes);
  if (!kind) {
    return { ok: false, errors: ['Only JPEG, PNG or WebP images can be uploaded.'] };
  }
  const meta = IMAGE_KIND_META[kind];
  const declared = (declaredType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared !== meta.contentType) {
    return { ok: false, errors: ['The file type does not match its contents.'] };
  }
  const dims = readImageDimensions(bytes, kind);
  if (!dims || dims.width < 1 || dims.height < 1) {
    return { ok: false, errors: ['The image could not be read. Export it again and retry.'] };
  }
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      errors: [`The image is ${dims.width} by ${dims.height} px; the limit is 6000 px per side.`],
    };
  }
  return {
    ok: true,
    value: { kind, contentType: meta.contentType, ext: meta.ext, bytes: bytes.length, ...dims },
  };
}

/**
 * `<product_id>/<uuid>.<ext>`: the only shape product_images.storage_path
 * accepts (0023). Built from server values only.
 */
export function buildImagePath(productId: string, imageId: string, kind: ImageKind): string {
  if (!isUuid(productId) || !isUuid(imageId)) {
    throw new Error('buildImagePath needs uuid product and image ids');
  }
  return `${productId.toLowerCase()}/${imageId.toLowerCase()}.${IMAGE_KIND_META[kind].ext}`;
}

/** Alt text is required (accessibility) and short. Whitespace collapses. */
export function parseAltText(raw: string | null | undefined): ParseResult<string> {
  const alt = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!alt) {
    return { ok: false, errors: ['Alt text is required: describe what the photo shows.'] };
  }
  if (alt.length > MAX_ALT_TEXT) {
    return { ok: false, errors: [`Alt text must be at most ${MAX_ALT_TEXT} characters.`] };
  }
  return { ok: true, value: alt };
}

/**
 * The browser's Origin must name this host. Server actions get this check
 * from Next; the upload is a route handler, so it repeats it.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Read at most maxBytes from a body stream. Null when it is larger, so an
 * oversized upload is cut off instead of buffered whole.
 */
export async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
