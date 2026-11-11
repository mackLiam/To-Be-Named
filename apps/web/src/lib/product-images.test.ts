import { describe, expect, it } from 'vitest';

import {
  jpeg,
  jpegSegment,
  jpegWith,
  png,
  pngChunk,
  pngWith,
  riffChunk,
  webpExtended,
  webpExtendedWith,
  webpLossless,
  webpLossy,
} from './image-fixtures.test-helpers';
import {
  MAX_IMAGE_BYTES,
  buildImagePath,
  isAnimatedWebp,
  isSameOrigin,
  parseAltText,
  readCappedBytes,
  readImageDimensions,
  sniffImageKind,
  stripImageMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
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
    expect(!result.ok && result.errors[0]).toBe('The file is larger than 4 MB.');
  });

  it('caps uploads at 4 MB, under the 4.5 MB Vercel request body limit', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(4194304); // bucket file_size_limit in 0023
  });

  it('accepts exactly 4 MB', () => {
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

  it('rejects an animated WebP by the VP8X animation flag (bit 1)', () => {
    const animated = webpExtendedWith(10, 10, 0x02, []);
    expect(isAnimatedWebp(animated)).toBe(true);
    const result = validateImageUpload(animated, 'image/webp');
    expect(result).toEqual({
      ok: false,
      errors: ['Animated WebP images cannot be uploaded. Export a still image.'],
    });
    // Every other flag (ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04) is a still image.
    const still = webpExtendedWith(10, 10, 0x3c, []);
    expect(isAnimatedWebp(still)).toBe(false);
    expect(validateImageUpload(still, 'image/webp').ok).toBe(true);
    expect(isAnimatedWebp(webpLossy(10, 10))).toBe(false);
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

const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0));
const contains = (haystack: Uint8Array, needle: string) =>
  Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));

describe('stripJpegMetadata', () => {
  // EXIF APP1 with a GPS IFD marker and coordinates as text, so the test can
  // look for the bytes afterwards.
  const gps = jpegSegment(0xe1, [...bytesOf('Exif\u0000\u0000GPSLatitude 51.5N'), 0, 0]);
  const xmp = jpegSegment(0xe1, bytesOf('http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta/>'));
  const iptc = jpegSegment(0xed, bytesOf('Photoshop 3.0\u0000IPTC'));
  const icc = jpegSegment(0xe2, bytesOf('ICC_PROFILE\u0000keep'));

  it('drops APP1 (EXIF with GPS, XMP) and APP13, keeping the rest and the frame', () => {
    const input = jpegWith(1600, 1200, [gps, icc, xmp, iptc]);
    const out = stripJpegMetadata(input)!;
    expect(out).not.toBeNull();
    expect(contains(out, 'GPSLatitude')).toBe(false);
    expect(contains(out, 'Exif')).toBe(false);
    expect(contains(out, 'xmpmeta')).toBe(false);
    expect(contains(out, 'Photoshop')).toBe(false);
    expect(contains(out, 'ICC_PROFILE')).toBe(true);
    expect(readImageDimensions(out, 'jpeg')).toEqual({ width: 1600, height: 1200 });
    // Exactly the plain JPEG with the kept ICC segment.
    expect(Array.from(out)).toEqual(Array.from(jpegWith(1600, 1200, [icc])));
  });

  it('copies the scan and everything after SOS unchanged', () => {
    const input = jpegWith(10, 10, [gps]);
    const sos = input.findIndex((b, i) => b === 0xff && input[i + 1] === 0xda);
    const out = stripJpegMetadata(input)!;
    const outSos = out.findIndex((b, i) => b === 0xff && out[i + 1] === 0xda);
    expect(Array.from(out.subarray(outSos))).toEqual(Array.from(input.subarray(sos)));
  });

  it('returns a JPEG without metadata unchanged, fill bytes included', () => {
    expect(Array.from(stripJpegMetadata(jpeg(640, 480))!)).toEqual(Array.from(jpeg(640, 480)));
  });

  it.each([
    ['not a JPEG', png(10, 10)],
    ['a segment longer than the file', Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 1, 2])],
    ['a segment length below 2', Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0xff, 0xda])],
    ['no SOS', jpeg(10, 10).subarray(0, 40)],
    ['EOI before SOS', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
    ['garbage where a marker belongs', Uint8Array.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xda])],
    ['a truncated marker', Uint8Array.from([0xff, 0xd8, 0xff])],
    ['a truncated length', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
  ])('rejects %s', (_label, bytes) => {
    expect(stripJpegMetadata(bytes)).toBeNull();
    expect(stripImageMetadata(bytes, 'jpeg')).toEqual({
      ok: false,
      errors: ['The image could not be read. Export it again and retry.'],
    });
  });
});

describe('stripPngMetadata', () => {
  const text = pngChunk('tEXt', bytesOf('Comment\u0000secret'));
  const itxt = pngChunk('iTXt', bytesOf('XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000<x/>'));
  const ztxt = pngChunk('zTXt', bytesOf('Author\u0000\u0000xx'));
  const exif = pngChunk('eXIf', bytesOf('MM\u0000*GPS'));
  const phys = pngChunk('pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]);

  it('drops eXIf and the text chunks, keeping every other chunk in order', () => {
    const out = stripPngMetadata(pngWith(800, 600, [text, phys, itxt, ztxt, exif]))!;
    expect(Array.from(out)).toEqual(Array.from(pngWith(800, 600, [phys])));
    expect(contains(out, 'secret')).toBe(false);
    expect(contains(out, 'GPS')).toBe(false);
    expect(readImageDimensions(out, 'png')).toEqual({ width: 800, height: 600 });
  });

  it('returns a clean PNG unchanged and drops bytes after IEND', () => {
    expect(Array.from(stripPngMetadata(png(10, 10))!)).toEqual(Array.from(png(10, 10)));
    const trailing = Uint8Array.from([...png(10, 10), ...bytesOf('<script>')]);
    expect(Array.from(stripPngMetadata(trailing)!)).toEqual(Array.from(png(10, 10)));
  });

  it.each([
    ['no IEND', png(10, 10).subarray(0, png(10, 10).length - 12)],
    [
      'a chunk longer than the file',
      Uint8Array.from([...png(10, 10).subarray(0, 8), 0, 0, 1, 0, 0x49]),
    ],
    ['not a PNG', jpeg(10, 10)],
  ])('rejects %s', (_label, bytes) => {
    expect(stripPngMetadata(bytes)).toBeNull();
    expect(stripImageMetadata(bytes, 'png').ok).toBe(false);
  });
});

describe('stripWebpMetadata', () => {
  const exif = riffChunk('EXIF', bytesOf('MM\u0000*GPSLatitude'));
  const xmp = riffChunk('XMP ', bytesOf('<x:xmpmeta/>!')); // odd size: padded
  const iccp = riffChunk('ICCP', bytesOf('icc'));
  const image = riffChunk('VP8L', [0x2f, 9, 0x40, 2, 0]);

  it('drops EXIF and XMP chunks, clears their flags, and fixes the RIFF size', () => {
    const out = stripWebpMetadata(webpExtendedWith(10, 10, 0x2c, [iccp, image, exif, xmp]))!;
    expect(Array.from(out)).toEqual(Array.from(webpExtendedWith(10, 10, 0x20, [iccp, image])));
    expect(contains(out, 'GPS')).toBe(false);
    expect(contains(out, 'xmpmeta')).toBe(false);
    const riffSize = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(riffSize).toBe(out.length - 8);
    expect(readImageDimensions(out, 'webp')).toEqual({ width: 10, height: 10 });
  });

  it('returns simple WebP files unchanged', () => {
    for (const file of [webpLossy(10, 10), webpLossless(10, 10), webpExtended(10, 10)]) {
      expect(Array.from(stripWebpMetadata(file)!)).toEqual(Array.from(file));
    }
  });

  it('rejects broken containers and animation chunks', () => {
    const overrun = webpExtendedWith(10, 10, 0, [image]);
    overrun[34] = 0xff; // VP8L size field
    expect(stripWebpMetadata(overrun)).toBeNull();
    const longRiff = webpLossy(10, 10);
    longRiff[4] = 0xff;
    expect(stripWebpMetadata(longRiff)).toBeNull();
    expect(stripWebpMetadata(webpExtendedWith(10, 10, 0, [riffChunk('ANMF', [0, 0])]))).toBeNull();
    expect(stripWebpMetadata(webpLossy(10, 10).subarray(0, 12))).toBeNull();
    expect(stripImageMetadata(png(10, 10), 'webp').ok).toBe(false);
  });
});
