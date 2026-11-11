/**
 * Catalog photo upload rules. Pure: type sniffing by magic bytes, header
 * level dimension parsing for JPEG, PNG and WebP (no image dependency), the
 * size and dimension caps, metadata stripping, server-side path generation,
 * alt text, and the same-origin check for the upload route. Every upload is untrusted input:
 * the declared Content-Type and the client's filename are never believed.
 */

import { isUuid } from './ids';
import type { ParseResult } from './shop';

/**
 * Mirrors the bucket file_size_limit (0023). Below Vercel's 4.5 MB request
 * body limit, so the route's own 413 is what an admin sees, not the platform's.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_SIZE_LABEL = '4 MB';
/** Per side. Bounds decode memory for anything that later renders the file. */
export const MAX_IMAGE_DIMENSION = 6000;
/** Bounds every gallery read and the reorder renumbering. */
export const MAX_IMAGES_PER_PRODUCT = 12;
export const MAX_ALT_TEXT = 200;
/** Custom header the upload route requires: forms cannot set it, so a
 * cross-site form post never reaches the handler (CSRF). */
export const UPLOAD_HEADER = 'x-forms-admin-upload';

export type ImageKind = 'jpeg' | 'png' | 'webp';

const UNREADABLE = 'The image could not be read. Export it again and retry.';

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
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
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

// VP8X flags byte (file offset 20), WebP container spec: reserved (2 bits),
// ICC, alpha, EXIF, XMP, animation, reserved; most significant bit first.
const VP8X_FLAGS_OFFSET = 20;
const VP8X_ANIMATION = 0x02;
const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;

/** An extended WebP whose VP8X header sets the animation flag. */
export function isAnimatedWebp(b: Uint8Array): boolean {
  return (
    ascii(b, 12, 4) === 'VP8X' &&
    b.length > VP8X_FLAGS_OFFSET &&
    (b[VP8X_FLAGS_OFFSET]! & VP8X_ANIMATION) !== 0
  );
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
    return { ok: false, errors: [`The file is larger than ${MAX_IMAGE_SIZE_LABEL}.`] };
  }
  const kind = sniffImageKind(bytes);
  if (!kind) {
    return { ok: false, errors: ['Only JPEG, PNG or WebP images can be uploaded.'] };
  }
  if (kind === 'webp' && isAnimatedWebp(bytes)) {
    return {
      ok: false,
      errors: ['Animated WebP images cannot be uploaded. Export a still image.'],
    };
  }
  const meta = IMAGE_KIND_META[kind];
  const declared = (declaredType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared !== meta.contentType) {
    return { ok: false, errors: ['The file type does not match its contents.'] };
  }
  const dims = readImageDimensions(bytes, kind);
  if (!dims || dims.width < 1 || dims.height < 1) {
    return { ok: false, errors: [UNREADABLE] };
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

// ---------------------------------------------------------------------------
// Metadata stripping. Catalog photos are public, and phone photos carry GPS
// coordinates and device details. Each walker copies whole segments or
// chunks, never decodes pixels, and advances at least one byte per step, so
// it is linear in the (capped) file size.
// ---------------------------------------------------------------------------

function concatRanges(b: Uint8Array, ranges: readonly (readonly [number, number])[]): Uint8Array {
  const total = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const [start, end] of ranges) {
    out.set(b.subarray(start, end), offset);
    offset += end - start;
  }
  return out;
}

// APP1 holds EXIF (GPS, device) and XMP; APP13 holds Photoshop IPTC.
const JPEG_DROP = new Set([0xe1, 0xed]);

/**
 * Drops APP1 and APP13 segments before the first SOS; the scan and
 * everything after it are copied unchanged. Null when the marker structure
 * is broken or there is no SOS.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (!startsWith(b, [0xff, 0xd8])) {
    return null;
  }
  const keep: [number, number][] = [[0, 2]];
  let o = 2;
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) {
      return null;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      keep.push([o, o + 1]); // fill byte
      o += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push([o, o + 2]);
      o += 2;
      continue;
    }
    // SOI again, EOI before any scan, or a stuffed zero: not a valid header.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) {
      return null;
    }
    if (o + 4 > b.length) {
      return null;
    }
    const end = o + 2 + u16be(b, o + 2);
    if (end < o + 4 || end > b.length) {
      return null;
    }
    if (marker === 0xda) {
      keep.push([o, b.length]);
      return concatRanges(b, keep);
    }
    if (!JPEG_DROP.has(marker)) {
      keep.push([o, end]);
    }
    o = end;
  }
  return null;
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

/**
 * Drops eXIf and the three text chunk types; every other chunk is copied
 * unchanged (CRCs included) through IEND, and anything after IEND is dropped.
 * Null when a chunk overruns the file or there is no IEND.
 */
export function stripPngMetadata(b: Uint8Array): Uint8Array | null {
  if (!startsWith(b, PNG_SIGNATURE)) {
    return null;
  }
  const keep: [number, number][] = [[0, PNG_SIGNATURE.length]];
  let o = PNG_SIGNATURE.length;
  while (o + 12 <= b.length) {
    // length + type + data + CRC
    const end = o + 12 + u32be(b, o);
    if (end > b.length) {
      return null;
    }
    const type = ascii(b, o + 4, 4);
    if (!PNG_DROP.has(type)) {
      keep.push([o, end]);
    }
    o = end;
    if (type === 'IEND') {
      return concatRanges(b, keep);
    }
  }
  return null;
}

const WEBP_DROP = new Set(['EXIF', 'XMP ']);

/**
 * Drops EXIF and XMP chunks, clears their VP8X flags, and rewrites the RIFF
 * size; other chunks are copied unchanged and bytes past the RIFF size are
 * dropped. Null when a chunk overruns the RIFF payload, or for animation
 * chunks (validateImageUpload refuses animated files by their flag).
 */
export function stripWebpMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') {
    return null;
  }
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length) {
    return null;
  }
  const keep: [number, number][] = [[0, 12]];
  let o = 12;
  while (o < riffEnd) {
    if (o + 8 > riffEnd) {
      return null;
    }
    const type = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    // Odd-sized chunks carry one pad byte.
    const end = o + 8 + size + (size & 1);
    if (end > riffEnd) {
      return null;
    }
    if (type === 'ANIM' || type === 'ANMF') {
      return null;
    }
    if (!WEBP_DROP.has(type)) {
      keep.push([o, end]);
    }
    o = end;
  }
  if (keep.length === 1) {
    return null;
  }
  const out = concatRanges(b, keep);
  const size = out.length - 8;
  out[4] = size & 0xff;
  out[5] = (size >>> 8) & 0xff;
  out[6] = (size >>> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  if (ascii(out, 12, 4) === 'VP8X' && out.length > VP8X_FLAGS_OFFSET) {
    out[VP8X_FLAGS_OFFSET] = out[VP8X_FLAGS_OFFSET]! & ~(VP8X_EXIF | VP8X_XMP);
  }
  return out;
}

/**
 * The bytes to store: the upload without location, device and text
 * metadata. Run after validateImageUpload; a structure the walker cannot
 * follow is refused rather than stored with its metadata intact.
 */
export function stripImageMetadata(bytes: Uint8Array, kind: ImageKind): ParseResult<Uint8Array> {
  const out =
    kind === 'jpeg'
      ? stripJpegMetadata(bytes)
      : kind === 'png'
        ? stripPngMetadata(bytes)
        : stripWebpMetadata(bytes);
  return out ? { ok: true, value: out } : { ok: false, errors: [UNREADABLE] };
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
