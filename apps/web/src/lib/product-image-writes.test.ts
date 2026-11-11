import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { AdminDecision } from './access';
import { jpeg, jpegSegment, jpegWith, png, webpExtendedWith } from './image-fixtures.test-helpers';
import {
  IMAGE_CACHE_SECONDS,
  deleteProductImage,
  handleImageUpload,
  isStorageNotFound,
  moveImage,
  setMainImage,
  supabaseImageStorage,
  updateImageAlt,
  uploadProductImage,
  type ImageStorage,
  type ProductImageRepo,
  type UploadRequest,
} from './product-image-writes';
import { MAX_IMAGES_PER_PRODUCT, MAX_IMAGE_BYTES, UPLOAD_HEADER } from './product-images';
import type { ProductImageRow } from './types';

const PRODUCT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_PRODUCT = '00000000-0000-4000-8000-0000000000c2';
const id = (n: number) => `00000000-0000-4000-8000-0000000000e${n}`;

function row(n: number, patch: Partial<ProductImageRow> = {}): ProductImageRow {
  return {
    id: id(n),
    product_id: PRODUCT,
    storage_path: `${PRODUCT}/${id(n)}.jpg`,
    alt_text: `Photo ${n}`,
    sort_order: n,
    is_main: false,
    created_at: '2026-11-10T00:00:00Z',
    ...patch,
  };
}

/** In-memory repo and bucket that enforce the 0023 one-main rule. */
function fakes(
  initial: ProductImageRow[] = [],
  opts: { insertFails?: boolean; products?: string[] } = {},
) {
  const rows = initial.map((r) => ({ ...r }));
  const objects = new Set(rows.map((r) => r.storage_path));
  const audits: {
    actor: string;
    action: string;
    productId: string;
    detail: Record<string, unknown>;
  }[] = [];
  const removed: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const repo: ProductImageRepo = {
    async productExists(productId) {
      return (opts.products ?? [PRODUCT]).includes(productId);
    },
    async listImages(productId) {
      return rows
        .filter((r) => r.product_id === productId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((r) => ({ ...r }));
    },
    async insertImage(newRow) {
      if (opts.insertFails) {
        throw { code: '23514' };
      }
      rows.push({ ...newRow, created_at: '2026-11-10T01:00:00Z' });
    },
    async updateImage(productId, imageId, patch) {
      const target = rows.find((r) => r.id === imageId && r.product_id === productId);
      if (!target) {
        return false;
      }
      if (
        patch.is_main &&
        rows.some((r) => r.product_id === productId && r.is_main && r !== target)
      ) {
        throw { code: '23505' };
      }
      Object.assign(target, patch);
      return true;
    },
    async clearMain(productId) {
      for (const r of rows) {
        if (r.product_id === productId) {
          r.is_main = false;
        }
      }
    },
    async deleteImage(productId, imageId) {
      const index = rows.findIndex((r) => r.id === imageId && r.product_id === productId);
      if (index >= 0) {
        rows.splice(index, 1);
      }
    },
    async audit(actor, action, productId, detail) {
      audits.push({ actor, action, productId, detail });
    },
  };
  const storage: ImageStorage = {
    async upload(path, bytes) {
      if (objects.has(path)) {
        throw new Error('exists');
      }
      objects.add(path);
      stored.set(path, bytes);
    },
    async remove(path) {
      removed.push(path);
      objects.delete(path);
    },
  };
  return { repo, storage, rows, objects, audits, removed, stored };
}

describe('uploadProductImage', () => {
  it('stores the object at a generated path, makes the first photo main, and audits', async () => {
    const f = fakes();
    const result = await uploadProductImage(f.repo, f.storage, 'a@x', {
      productId: PRODUCT,
      bytes: png(800, 600),
      declaredType: 'image/png',
      alt: ' Front view ',
      newId: () => id(9),
    });
    expect(result).toEqual({ error: null, id: id(9) });
    expect([...f.objects]).toEqual([`${PRODUCT}/${id(9)}.png`]);
    expect(f.rows[0]).toMatchObject({ alt_text: 'Front view', is_main: true, sort_order: 0 });
    expect(f.audits[0]).toMatchObject({
      action: 'product.image.upload',
      productId: PRODUCT,
      detail: { image_id: id(9), width: 800, height: 600, content_type: 'image/png' },
    });
  });

  it('appends later photos after the last one, not as main', async () => {
    const f = fakes([row(0, { is_main: true }), row(4)]);
    await uploadProductImage(f.repo, f.storage, 'a', {
      productId: PRODUCT,
      bytes: jpeg(10, 10),
      declaredType: 'image/jpeg',
      alt: 'Side',
      newId: () => id(9),
    });
    expect(f.rows.at(-1)).toMatchObject({ sort_order: 5, is_main: false });
  });

  it('stores the photo without its EXIF GPS block and audits the stored size', async () => {
    const f = fakes();
    const gps = jpegSegment(0xe1, [...new TextEncoder().encode('Exif\u0000\u0000GPS 51.5N'), 0]);
    const input = jpegWith(1600, 1200, [gps]);
    await uploadProductImage(f.repo, f.storage, 'a', {
      productId: PRODUCT,
      bytes: input,
      declaredType: 'image/jpeg',
      alt: 'Front',
      newId: () => id(9),
    });
    const saved = f.stored.get(`${PRODUCT}/${id(9)}.jpg`)!;
    expect(Array.from(saved)).toEqual(Array.from(jpeg(1600, 1200)));
    expect(saved.length).toBe(input.length - gps.length);
    expect(f.audits[0]!.detail).toMatchObject({ bytes: saved.length, width: 1600, height: 1200 });
  });

  it('refuses invalid input before touching storage', async () => {
    const cases = [
      { bytes: png(10, 10), declaredType: 'image/jpeg', alt: 'x' },
      // Animated WebP (VP8X animation flag).
      { bytes: webpExtendedWith(10, 10, 0x02, []), declaredType: 'image/webp', alt: 'x' },
      // Frame header readable, but no scan: the metadata walk cannot finish.
      { bytes: jpeg(10, 10).subarray(0, 40), declaredType: 'image/jpeg', alt: 'x' },
      // PNG with no IEND.
      { bytes: png(10, 10).subarray(0, 33), declaredType: 'image/png', alt: 'x' },
      { bytes: new TextEncoder().encode('<svg/>'), declaredType: 'image/png', alt: 'x' },
      { bytes: png(7000, 10), declaredType: 'image/png', alt: 'x' },
      { bytes: png(10, 10), declaredType: 'image/png', alt: '' },
    ];
    for (const input of cases) {
      const f = fakes();
      const result = await uploadProductImage(f.repo, f.storage, 'a', {
        productId: PRODUCT,
        ...input,
      });
      expect(result.error).toBeTruthy();
      expect(f.objects.size).toBe(0);
      expect(f.audits).toEqual([]);
    }
  });

  it('refuses an unknown product and a full gallery', async () => {
    const missing = fakes([], { products: [] });
    expect(
      (
        await uploadProductImage(missing.repo, missing.storage, 'a', {
          productId: PRODUCT,
          bytes: png(10, 10),
          declaredType: 'image/png',
          alt: 'x',
        })
      ).error,
    ).toBe('Product not found.');

    const full = fakes(Array.from({ length: MAX_IMAGES_PER_PRODUCT }, (_, i) => row(i)));
    const result = await uploadProductImage(full.repo, full.storage, 'a', {
      productId: PRODUCT,
      bytes: png(10, 10),
      declaredType: 'image/png',
      alt: 'x',
    });
    expect(result.error).toMatch(/at most 12 photos/);
  });

  it('removes the uploaded object when the row insert fails', async () => {
    const f = fakes([], { insertFails: true });
    await expect(
      uploadProductImage(f.repo, f.storage, 'a', {
        productId: PRODUCT,
        bytes: png(10, 10),
        declaredType: 'image/png',
        alt: 'x',
        newId: () => id(9),
      }),
    ).rejects.toEqual({ code: '23514' });
    expect(f.objects.size).toBe(0);
    expect(f.audits).toEqual([]);
  });
});

describe('setMainImage', () => {
  it('moves main to the chosen photo and audits', async () => {
    const f = fakes([row(1, { is_main: true }), row(2)]);
    expect(await setMainImage(f.repo, 'a', PRODUCT, id(2))).toEqual({ error: null });
    expect(f.rows.filter((r) => r.is_main).map((r) => r.id)).toEqual([id(2)]);
    expect(f.audits[0]).toMatchObject({
      action: 'product.image.main',
      detail: { image_id: id(2) },
    });
  });

  it('is a no-op when already main, and refuses another product photo', async () => {
    const f = fakes([row(1, { is_main: true })]);
    expect(await setMainImage(f.repo, 'a', PRODUCT, id(1))).toEqual({ error: null });
    expect(f.audits).toEqual([]);
    expect((await setMainImage(f.repo, 'a', OTHER_PRODUCT, id(1))).error).toBe('Photo not found.');
  });

  it('turns a concurrent main change into a form error', async () => {
    const f = fakes([row(1, { is_main: true }), row(2)]);
    f.repo.clearMain = async () => undefined;
    expect((await setMainImage(f.repo, 'a', PRODUCT, id(2))).error).toMatch(/same time/);
  });
});

describe('updateImageAlt', () => {
  it('validates, updates and audits', async () => {
    const f = fakes([row(1)]);
    expect(await updateImageAlt(f.repo, 'a', PRODUCT, id(1), 'New alt')).toEqual({ error: null });
    expect(f.rows[0]!.alt_text).toBe('New alt');
    expect(f.audits[0]).toMatchObject({ action: 'product.image.alt' });
  });

  it('refuses empty, too long and unknown', async () => {
    const f = fakes([row(1)]);
    expect((await updateImageAlt(f.repo, 'a', PRODUCT, id(1), ' ')).error).toMatch(/required/);
    expect((await updateImageAlt(f.repo, 'a', PRODUCT, id(1), 'a'.repeat(201))).error).toMatch(
      /200/,
    );
    expect((await updateImageAlt(f.repo, 'a', PRODUCT, id(8), 'ok')).error).toBe(
      'Photo not found.',
    );
    expect(f.audits).toEqual([]);
  });
});

describe('moveImage', () => {
  it('swaps sort order with the neighbour', async () => {
    const f = fakes([row(0), row(1), row(2)]);
    await moveImage(f.repo, 'a', PRODUCT, id(2), 'up');
    const order = (await f.repo.listImages(PRODUCT)).map((r) => r.id);
    expect(order).toEqual([id(0), id(2), id(1)]);
    expect(f.audits).toHaveLength(1);
  });

  it('does nothing at the end, and refuses unknown photos', async () => {
    const f = fakes([row(0), row(1)]);
    expect(await moveImage(f.repo, 'a', PRODUCT, id(1), 'down')).toEqual({ error: null });
    expect(f.audits).toEqual([]);
    expect((await moveImage(f.repo, 'a', PRODUCT, id(7), 'up')).error).toBe('Photo not found.');
  });
});

describe('deleteProductImage', () => {
  it('removes the object, then the row, and promotes the next photo to main', async () => {
    const f = fakes([row(0, { is_main: true }), row(1)]);
    expect(await deleteProductImage(f.repo, f.storage, 'a', PRODUCT, id(0))).toEqual({
      error: null,
    });
    expect(f.removed).toEqual([`${PRODUCT}/${id(0)}.jpg`]);
    expect(f.rows.map((r) => [r.id, r.is_main])).toEqual([[id(1), true]]);
    expect(f.audits[0]).toMatchObject({
      action: 'product.image.delete',
      detail: { promoted_main: id(1) },
    });
  });

  it('treats an already deleted photo as success', async () => {
    const f = fakes([]);
    expect(await deleteProductImage(f.repo, f.storage, 'a', PRODUCT, id(0))).toEqual({
      error: null,
    });
    expect(f.removed).toEqual([]);
  });

  it('keeps the row when the object removal fails, so a retry can finish', async () => {
    const f = fakes([row(0)]);
    f.storage.remove = async () => {
      throw new Error('storage down');
    };
    await expect(deleteProductImage(f.repo, f.storage, 'a', PRODUCT, id(0))).rejects.toThrow(
      'storage down',
    );
    expect(f.rows).toHaveLength(1);
  });

  it('never deletes a photo through the wrong product', async () => {
    const f = fakes([row(0)]);
    await deleteProductImage(f.repo, f.storage, 'a', OTHER_PRODUCT, id(0));
    expect(f.rows).toHaveLength(1);
    expect(f.removed).toEqual([]);
  });
});

describe('isStorageNotFound', () => {
  it('recognizes the shapes storage uses for a missing object', () => {
    expect(isStorageNotFound({ status: 404 })).toBe(true);
    expect(isStorageNotFound({ statusCode: '404' })).toBe(true);
    expect(isStorageNotFound({ statusCode: 500 })).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
    expect(isStorageNotFound('404')).toBe(false);
  });
});

describe('handleImageUpload', () => {
  const ADMIN: AdminDecision = { kind: 'allow', user: { id: 'u1', email: 'admin@x.test' } };

  function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function request(patch: Partial<UploadRequest> = {}, f = fakes()) {
    const bytes = png(100, 100);
    const req: UploadRequest = {
      decision: ADMIN,
      serviceConfigured: true,
      productId: PRODUCT,
      origin: 'https://zells.com',
      host: 'zells.com',
      uploadHeader: '1',
      contentType: 'image/png',
      contentLength: String(bytes.length),
      alt: 'Front',
      body: body(bytes),
      getWriter: () => ({ repo: f.repo, storage: f.storage }),
      newId: () => id(9),
      ...patch,
    };
    return { req, f };
  }

  it('uploads for an aal2 admin and audits with their email', async () => {
    const { req, f } = request();
    expect(await handleImageUpload(req)).toEqual({ status: 201, body: { id: id(9) } });
    expect(f.audits[0]!.actor).toBe('admin@x.test');
    expect(UPLOAD_HEADER).toBe('x-forms-admin-upload');
  });

  it.each(['deny', 'mfa_enroll', 'mfa_verify'] as const)('404s a %s decision', async (kind) => {
    const { req, f } = request({ decision: { kind } });
    expect((await handleImageUpload(req)).status).toBe(404);
    expect(f.objects.size).toBe(0);
  });

  it('403s a cross-site request or one without the custom header', async () => {
    for (const patch of [
      { origin: 'https://evil.example' },
      { origin: null },
      { uploadHeader: null },
    ]) {
      const { req, f } = request(patch);
      expect((await handleImageUpload(req)).status).toBe(403);
      expect(f.objects.size).toBe(0);
    }
  });

  it('is read-only in fake mode or without a service role', async () => {
    expect((await handleImageUpload(request({ decision: { kind: 'fake' } }).req)).status).toBe(409);
    expect((await handleImageUpload(request({ serviceConfigured: false }).req)).status).toBe(409);
  });

  it('rejects a bad product id, missing alt text and oversized bodies', async () => {
    expect((await handleImageUpload(request({ productId: '../x' }).req)).status).toBe(404);
    expect((await handleImageUpload(request({ alt: '' }).req)).status).toBe(400);
    expect(
      await handleImageUpload(request({ contentLength: String(MAX_IMAGE_BYTES + 1) }).req),
    ).toEqual({ status: 413, body: { error: 'The file is larger than 4 MB.' } });
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(png(10, 10));
    expect(await handleImageUpload(request({ contentLength: null, body: body(big) }).req)).toEqual({
      status: 413,
      body: { error: 'The file is larger than 4 MB.' },
    });
  });

  it('400s a file whose bytes are not the declared image', async () => {
    const { req, f } = request({ contentType: 'image/jpeg' });
    const result = await handleImageUpload(req);
    expect(result.status).toBe(400);
    expect(f.objects.size).toBe(0);
  });

  it('404s an unknown product and 500s an unexpected failure without detail', async () => {
    const missing = request({}, fakes([], { products: [] }));
    expect((await handleImageUpload(missing.req)).status).toBe(404);
    const broken = request({}, fakes([], { insertFails: true }));
    expect(await handleImageUpload(broken.req)).toEqual({
      status: 500,
      body: { error: 'Upload failed. Try again.' },
    });
  });
});

describe('supabaseImageStorage', () => {
  it('uploads without upsert and with a one-hour cache', async () => {
    const upload = vi.fn(async () => ({ data: {}, error: null }));
    const client = { storage: { from: () => ({ upload }) } } as unknown as SupabaseClient;
    const bytes = png(10, 10);
    await supabaseImageStorage(client).upload('p/i.png', bytes, 'image/png');
    expect(IMAGE_CACHE_SECONDS).toBe(3600);
    expect(upload).toHaveBeenCalledWith('p/i.png', bytes, {
      contentType: 'image/png',
      upsert: false,
      cacheControl: '3600',
    });
  });
});
