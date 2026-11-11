import { describe, expect, it } from 'vitest';

import { jpeg, png, webpExtended, webpLossless, webpLossy } from './image-fixtures.test-helpers';
import {
  MAX_IMAGE_BYTES,
  buildImagePath,
  isSameOrigin,
  parseAltText,
  readCappedBytes,
  readImageDimensions,
  sniffImageKind,
  validateImageUpload,
} from './product-images';

const PRODUCT = '00000000-0000-4000-8000-0000000000c1';
const IMAGE = '00000000-0000-4000-8000-0000000000e1';

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('sniffImageKind', () => {
  it('recognizes each allowed type by its magic bytes', () => {
    expect(sniffImageKind(jpeg(10, 10))).toBe('jpeg');
    expect(sniffImageKind(png(10, 10))).toBe('png');
    expect(sniffImageKind(webpLossy(10, 10))).toBe('webp');
  });

  it.each([
    ['GIF', new TextEncoder().encode('GIF89a......')],
    ['SVG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['PDF', new TextEncoder().encode('%PDF-1.7')],
    ['RIFF that is not WebP', new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')],
    ['truncated PNG signature', Uint8Array.from([0x89, 0x50, 0x4e])],
    ['empty', new Uint8Array(0)],
  ])('rejects %s', (_label, bytes) => {
    expect(sniffImageKind(bytes)).toBeNull();
  });
});

describe('readImageDimensions', () => {
  it('reads PNG IHDR', () => {
    expect(readImageDimensions(png(1200, 800), 'png')).toEqual({ width: 1200, height: 800 });
  });

  it('reads JPEG baseline and progressive frames, skipping fill bytes', () => {
    expect(readImageDimensions(jpeg(4000, 3000), 'jpeg')).toEqual({ width: 4000, height: 3000 });
    expect(readImageDimensions(jpeg(640, 480, 0xc2), 'jpeg')).toEqual({ width: 640, height: 480 });
  });

  it('reads all three WebP variants', () => {
    expect(readImageDimensions(webpLossy(1024, 768), 'webp')).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(webpLossless(5000, 3), 'webp')).toEqual({ width: 5000, height: 3 });
    expect(readImageDimensions(webpExtended(6000, 4500), 'webp')).toEqual({
      width: 6000,
      height: 4500,
    });
  });

  it('returns null for headers that do not parse', () => {
    expect(readImageDimensions(png(10, 10).slice(0, 20), 'png')).toBeNull();
    const badIhdr = png(10, 10);
    badIhdr[12] = 0x58;
    expect(readImageDimensions(badIhdr, 'png')).toBeNull();
    // JPEG whose first non-APP marker is scan data: no frame header.
    const noSof = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
    expect(readImageDimensions(noSof, 'jpeg')).toBeNull();
    // DHT (0xc4) is in the SOF range but is not a frame.
    expect(readImageDimensions(jpeg(10, 10, 0xc4), 'jpeg')).toBeNull();
    expect(readImageDimensions(jpeg(10, 10).slice(0, 26), 'jpeg')).toBeNull();
    const lossyNoStart = webpLossy(10, 10);
    lossyNoStart[23] = 0;
    expect(readImageDimensions(lossyNoStart, 'webp')).toBeNull();
    const losslessNoSig = webpLossless(10, 10);
    losslessNoSig[20] = 0;
    expect(readImageDimensions(losslessNoSig, 'webp')).toBeNull();
  });
});

describe('validateImageUpload', () => {
  it('accepts a valid image whose declared type matches', () => {
    const result = validateImageUpload(jpeg(1600, 1200), 'image/jpeg');
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'jpeg',
        contentType: 'image/jpeg',
        ext: 'jpg',
        bytes: jpeg(1600, 1200).length,
        width: 1600,
        height: 1200,
      },
    });
    expect(validateImageUpload(png(10, 10), 'image/png; charset=binary').ok).toBe(true);
    expect(validateImageUpload(webpLossy(10, 10), 'IMAGE/WEBP').ok).toBe(true);
  });

  it('rejects a mismatched or missing declared type (renamed file)', () => {
    expect(validateImageUpload(png(10, 10), 'image/jpeg').ok).toBe(false);
    expect(validateImageUpload(png(10, 10), null).ok).toBe(false);
    expect(validateImageUpload(png(10, 10), 'application/octet-stream').ok).toBe(false);
  });

  it('rejects contents that are not an allowed image even when the header says so', () => {
    const svg = new TextEncoder().encode('<svg onload="alert(1)"/>');
    const result = validateImageUpload(svg, 'image/png');
    expect(!result.ok && result.errors[0]).toMatch(/JPEG, PNG or WebP/);
  });

  it('rejects empty and oversized files', () => {
    expect(validateImageUpload(new Uint8Array(0), 'image/png').ok).toBe(false);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(png(10, 10));
    const result = validateImageUpload(big, 'image/png');
    expect(!result.ok && result.errors[0]).toMatch(/5 MB/);
  });

  it('accepts exactly 5 MB', () => {
    const edge = new Uint8Array(MAX_IMAGE_BYTES);
    edge.set(png(10, 10));
    expect(validateImageUpload(edge, 'image/png').ok).toBe(true);
  });

  it('enforces the 6000 px cap per side and rejects zero sizes', () => {
    expect(validateImageUpload(png(6000, 6000), 'image/png').ok).toBe(true);
    const wide = validateImageUpload(png(6001, 10), 'image/png');
    expect(!wide.ok && wide.errors[0]).toMatch(/6001 by 10 px/);
    expect(validateImageUpload(jpeg(10, 6001), 'image/jpeg').ok).toBe(false);
    expect(validateImageUpload(webpExtended(7000, 10), 'image/webp').ok).toBe(false);
    expect(validateImageUpload(png(0, 10), 'image/png').ok).toBe(false);
    expect(validateImageUpload(jpeg(10, 0), 'image/jpeg').ok).toBe(false);
  });

  it('rejects a valid magic number with an unreadable header', () => {
    const result = validateImageUpload(png(10, 10).slice(0, 16), 'image/png');
    expect(!result.ok && result.errors[0]).toMatch(/could not be read/);
  });
});

describe('buildImagePath', () => {
  it('is product id, generated id and the sniffed extension', () => {
    expect(buildImagePath(PRODUCT, IMAGE, 'jpeg')).toBe(`${PRODUCT}/${IMAGE}.jpg`);
    expect(buildImagePath(PRODUCT.toUpperCase(), IMAGE, 'webp')).toBe(`${PRODUCT}/${IMAGE}.webp`);
  });

  it('matches the 0023 storage_path check', () => {
    const shape = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
    expect(buildImagePath(PRODUCT, IMAGE, 'png')).toMatch(shape);
  });

  it('refuses anything that is not a uuid (no client filenames or traversal)', () => {
    expect(() => buildImagePath('../etc', IMAGE, 'png')).toThrow();
    expect(() => buildImagePath(PRODUCT, 'photo.png', 'png')).toThrow();
  });
});

describe('parseAltText', () => {
  it('trims and collapses whitespace', () => {
    expect(parseAltText('  Guard,\n front   view ')).toEqual({
      ok: true,
      value: 'Guard, front view',
    });
  });

  it('requires text and caps it at 200 characters', () => {
    expect(parseAltText('   ').ok).toBe(false);
    expect(parseAltText(null).ok).toBe(false);
    expect(parseAltText('a'.repeat(200)).ok).toBe(true);
    expect(parseAltText('a'.repeat(201)).ok).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('matches the origin host to the request host', () => {
    expect(isSameOrigin('https://zells.com', 'zells.com')).toBe(true);
    expect(isSameOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
  });

  it('refuses other, missing or malformed origins', () => {
    expect(isSameOrigin('https://evil.example', 'zells.com')).toBe(false);
    expect(isSameOrigin('https://zells.com.evil.example', 'zells.com')).toBe(false);
    expect(isSameOrigin(null, 'zells.com')).toBe(false);
    expect(isSameOrigin('null', 'zells.com')).toBe(false);
    expect(isSameOrigin('https://zells.com', null)).toBe(false);
  });
});

describe('readCappedBytes', () => {
  it('joins chunks under the cap', async () => {
    const out = await readCappedBytes(stream([Uint8Array.of(1, 2), Uint8Array.of(3)]), 3);
    expect(Array.from(out!)).toEqual([1, 2, 3]);
  });

  it('stops at the cap instead of buffering the rest', async () => {
    expect(await readCappedBytes(stream([Uint8Array.of(1, 2), Uint8Array.of(3, 4)]), 3)).toBeNull();
  });

  it('treats a missing body as empty', async () => {
    expect((await readCappedBytes(null, 3))!.length).toBe(0);
  });
});
