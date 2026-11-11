/**
 * Minimal valid image headers for upload tests. Only the bytes the
 * validators read are meaningful; the rest is padding.
 */

function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u24le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
}
function text(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** A PNG chunk: length, type, data, and a placeholder CRC (nothing here checks it). */
export function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...text(type), ...data, 0, 0, 0, 0];
}

/** PNG with extra chunks between IHDR and IEND. */
export function pngWith(width: number, height: number, chunks: number[][]): Uint8Array {
  const base = png(width, height);
  const iend = base.length - 12;
  return Uint8Array.from([...base.subarray(0, iend), ...chunks.flat(), ...base.subarray(iend)]);
}

export function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...text('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...pngChunk('IEND', []),
  ]);
}

/** A JPEG marker segment; the length field counts itself. */
export function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

/** JPEG with extra segments right after SOI. */
export function jpegWith(width: number, height: number, segments: number[][]): Uint8Array {
  const base = jpeg(width, height);
  return Uint8Array.from([...base.subarray(0, 2), ...segments.flat(), ...base.subarray(2)]);
}

/** JPEG with an APP0 segment (and optional fill bytes) before the SOF. */
export function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...text('JFIF'),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xff, // fill byte
    0xff,
    sof,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...u16be(8),
    0,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xd9,
  ]);
}

/** A RIFF chunk, padded to an even size. */
export function riffChunk(type: string, payload: number[]): number[] {
  return [
    ...text(type),
    ...u32be(payload.length).reverse(),
    ...payload,
    ...(payload.length % 2 ? [0] : []),
  ];
}

function riffOf(chunks: number[][]): Uint8Array {
  const body = [...text('WEBP'), ...chunks.flat()];
  return Uint8Array.from([...text('RIFF'), ...u32be(body.length).reverse(), ...body]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  return riffOf([riffChunk(chunk, payload)]);
}

export function webpLossy(width: number, height: number): Uint8Array {
  return riff('VP8 ', [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...u16le(width),
    ...u16le(height),
    0,
    0,
  ]);
}

export function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff('VP8L', [
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
    0,
  ]);
}

export function webpExtended(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

/** Extended WebP: VP8X with these flags, then the given chunks. */
export function webpExtendedWith(
  width: number,
  height: number,
  flags: number,
  chunks: number[][],
): Uint8Array {
  return riffOf([
    riffChunk('VP8X', [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]),
    ...chunks,
  ]);
}
