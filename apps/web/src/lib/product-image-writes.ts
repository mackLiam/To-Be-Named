import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AdminDecision } from './access';
import { PRODUCT_IMAGES_BUCKET, planMove, type MoveDirection } from './catalog';
import {
  MAX_IMAGES_PER_PRODUCT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIZE_LABEL,
  buildImagePath,
  isSameOrigin,
  parseAltText,
  readCappedBytes,
  stripImageMetadata,
  validateImageUpload,
} from './product-images';
import { isUuid } from './shop';
import type { ProductImageRow } from './types';

/**
 * Admin writes for catalog photos. Decisions live here; the database and the
 * bucket sit behind two small seams sized to what these functions use
 * (production impls at the bottom, in-memory fakes in tests). Every write
 * records one audit_log row against the product (subject_table 'products').
 * Expected refusals come back as { error }; anything else throws.
 */

export interface ImageWriteResult {
  error: string | null;
  id?: string;
}

const OK: ImageWriteResult = { error: null };

export interface ProductImageRepo {
  productExists(productId: string): Promise<boolean>;
  /** The product's images, sort_order then created_at, at most MAX_IMAGES_PER_PRODUCT + 1. */
  listImages(productId: string): Promise<ProductImageRow[]>;
  insertImage(row: Omit<ProductImageRow, 'created_at'>): Promise<void>;
  /** False when no image with that id belongs to the product. */
  updateImage(
    productId: string,
    imageId: string,
    patch: Partial<Pick<ProductImageRow, 'alt_text' | 'sort_order' | 'is_main'>>,
  ): Promise<boolean>;
  clearMain(productId: string): Promise<void>;
  deleteImage(productId: string, imageId: string): Promise<void>;
  audit(
    actor: string,
    action: string,
    productId: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
}

export interface ImageStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Removing an object that is already gone succeeds. */
  remove(path: string): Promise<void>;
}

export async function uploadProductImage(
  repo: ProductImageRepo,
  storage: ImageStorage,
  actor: string,
  input: {
    productId: string;
    bytes: Uint8Array;
    declaredType: string | null;
    alt: string | null;
    newId?: () => string;
  },
): Promise<ImageWriteResult> {
  const alt = parseAltText(input.alt);
  if (!alt.ok) {
    return { error: alt.errors.join(' ') };
  }
  const image = validateImageUpload(input.bytes, input.declaredType);
  if (!image.ok) {
    return { error: image.errors.join(' ') };
  }
  const stored = stripImageMetadata(input.bytes, image.value.kind);
  if (!stored.ok) {
    return { error: stored.errors.join(' ') };
  }
  if (!(await repo.productExists(input.productId))) {
    return { error: 'Product not found.' };
  }
  const existing = await repo.listImages(input.productId);
  if (existing.length >= MAX_IMAGES_PER_PRODUCT) {
    return { error: `A product can have at most ${MAX_IMAGES_PER_PRODUCT} photos.` };
  }

  const id = (input.newId ?? randomUUID)();
  const path = buildImagePath(input.productId, id, image.value.kind);
  const isMain = !existing.some((row) => row.is_main);
  const sortOrder = existing.reduce((max, row) => Math.max(max, row.sort_order + 1), 0);

  await storage.upload(path, stored.value, image.value.contentType);
  try {
    await repo.insertImage({
      id,
      product_id: input.productId,
      storage_path: path,
      alt_text: alt.value,
      sort_order: sortOrder,
      is_main: isMain,
    });
  } catch (error) {
    // No row points at the object, so nothing would ever clean it up.
    await storage.remove(path).catch(() => undefined);
    throw error;
  }
  await repo.audit(actor, 'product.image.upload', input.productId, {
    image_id: id,
    storage_path: path,
    content_type: image.value.contentType,
    bytes: stored.value.length,
    width: image.value.width,
    height: image.value.height,
    is_main: isMain,
  });
  return { error: null, id };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export async function setMainImage(
  repo: ProductImageRepo,
  actor: string,
  productId: string,
  imageId: string,
): Promise<ImageWriteResult> {
  const images = await repo.listImages(productId);
  const target = images.find((row) => row.id === imageId);
  if (!target) {
    return { error: 'Photo not found.' };
  }
  if (target.is_main) {
    return OK;
  }
  // Unset first: the partial unique index (0023) allows one main per product.
  await repo.clearMain(productId);
  try {
    if (!(await repo.updateImage(productId, imageId, { is_main: true }))) {
      return { error: 'Photo not found.' };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: 'Another change set the main photo at the same time. Reload and try again.' };
    }
    throw error;
  }
  await repo.audit(actor, 'product.image.main', productId, { image_id: imageId });
  return OK;
}

export async function updateImageAlt(
  repo: ProductImageRepo,
  actor: string,
  productId: string,
  imageId: string,
  rawAlt: string | null,
): Promise<ImageWriteResult> {
  const alt = parseAltText(rawAlt);
  if (!alt.ok) {
    return { error: alt.errors.join(' ') };
  }
  if (!(await repo.updateImage(productId, imageId, { alt_text: alt.value }))) {
    return { error: 'Photo not found.' };
  }
  await repo.audit(actor, 'product.image.alt', productId, {
    image_id: imageId,
    alt_text: alt.value,
  });
  return OK;
}

export async function moveImage(
  repo: ProductImageRepo,
  actor: string,
  productId: string,
  imageId: string,
  direction: MoveDirection,
): Promise<ImageWriteResult> {
  const images = await repo.listImages(productId);
  if (!images.some((row) => row.id === imageId)) {
    return { error: 'Photo not found.' };
  }
  const changes = planMove(
    images.map((row) => ({ id: row.id, order: row.sort_order })),
    imageId,
    direction,
  );
  for (const change of changes) {
    await repo.updateImage(productId, change.id, { sort_order: change.order });
  }
  if (changes.length > 0) {
    await repo.audit(actor, 'product.image.move', productId, { image_id: imageId, direction });
  }
  return OK;
}

/**
 * Object first, then row: if the row delete fails the retry finds the object
 * already gone (success) and finishes. A photo that is already deleted is
 * success too. Deleting the main photo promotes the next one.
 */
export async function deleteProductImage(
  repo: ProductImageRepo,
  storage: ImageStorage,
  actor: string,
  productId: string,
  imageId: string,
): Promise<ImageWriteResult> {
  const images = await repo.listImages(productId);
  const target = images.find((row) => row.id === imageId);
  if (!target) {
    return OK;
  }
  await storage.remove(target.storage_path);
  await repo.deleteImage(productId, imageId);
  const next = images.find((row) => row.id !== imageId);
  if (target.is_main && next) {
    await repo.updateImage(productId, next.id, { is_main: true });
  }
  await repo.audit(actor, 'product.image.delete', productId, {
    image_id: imageId,
    storage_path: target.storage_path,
    promoted_main: target.is_main && next ? next.id : null,
  });
  return OK;
}

// ---------------------------------------------------------------------------
// Upload route logic (app/admin/api/products/[id]/images/route.ts is the
// thin adapter). Same shape as stl.ts: decision in, status and body out.
// ---------------------------------------------------------------------------

export interface UploadRequest {
  decision: AdminDecision;
  serviceConfigured: boolean;
  productId: string;
  origin: string | null;
  host: string | null;
  uploadHeader: string | null;
  contentType: string | null;
  contentLength: string | null;
  alt: string | null;
  body: ReadableStream<Uint8Array> | null;
  getWriter(): { repo: ProductImageRepo; storage: ImageStorage };
  newId?: () => string;
}

export interface UploadResponse {
  status: number;
  body: { id: string } | { error: string };
}

const READ_ONLY = 'Read-only: no service role is configured, so photos cannot be uploaded.';
const TOO_LARGE = `The file is larger than ${MAX_IMAGE_SIZE_LABEL}.`;

export async function handleImageUpload(req: UploadRequest): Promise<UploadResponse> {
  // Anything short of an aal2 admin (or fake mode) is a 404, before any
  // other check, so the endpoint never reveals itself.
  if (req.decision.kind !== 'allow' && req.decision.kind !== 'fake') {
    return { status: 404, body: { error: 'Not found.' } };
  }
  if (!isSameOrigin(req.origin, req.host) || req.uploadHeader !== '1') {
    return { status: 403, body: { error: 'Upload refused: cross-site request.' } };
  }
  if (req.decision.kind === 'fake' || !req.serviceConfigured) {
    return { status: 409, body: { error: READ_ONLY } };
  }
  if (!isUuid(req.productId)) {
    return { status: 404, body: { error: 'Product not found.' } };
  }
  const alt = parseAltText(req.alt);
  if (!alt.ok) {
    return { status: 400, body: { error: alt.errors.join(' ') } };
  }
  const declaredLength = Number(req.contentLength ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return { status: 413, body: { error: TOO_LARGE } };
  }
  const bytes = await readCappedBytes(req.body, MAX_IMAGE_BYTES);
  if (bytes === null) {
    return { status: 413, body: { error: TOO_LARGE } };
  }

  const actor = req.decision.user.email ?? req.decision.user.id;
  const { repo, storage } = req.getWriter();
  try {
    const result = await uploadProductImage(repo, storage, actor, {
      productId: req.productId.toLowerCase(),
      bytes,
      declaredType: req.contentType,
      alt: alt.value,
      newId: req.newId,
    });
    if (result.error) {
      const status = result.error === 'Product not found.' ? 404 : 400;
      return { status, body: { error: result.error } };
    }
    return { status: 201, body: { id: result.id! } };
  } catch {
    return { status: 500, body: { error: 'Upload failed. Try again.' } };
  }
}

// ---------------------------------------------------------------------------
// Production seams (SERVICE ROLE client only). Thin by rule.
// ---------------------------------------------------------------------------

export const IMAGE_CACHE_SECONDS = 3600;

const IMAGE_COLUMNS = 'id, product_id, storage_path, alt_text, sort_order, is_main, created_at';

/** Storage reports a missing object as 404 (status or statusCode). */
export function isStorageNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as { status?: unknown; statusCode?: unknown };
  return e.status === 404 || e.statusCode === '404' || e.statusCode === 404;
}

export function supabaseImageStorage(client: SupabaseClient): ImageStorage {
  const bucket = () => client.storage.from(PRODUCT_IMAGES_BUCKET);
  return {
    async upload(path, bytes, contentType) {
      // Paths are fresh uuids, so no upsert is safe. The cache stays short so
      // a photo deleted by mistake stops being served within an hour.
      const { error } = await bucket().upload(path, bytes, {
        contentType,
        upsert: false,
        cacheControl: String(IMAGE_CACHE_SECONDS),
      });
      if (error) {
        throw error;
      }
    },
    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error && !isStorageNotFound(error)) {
        throw error;
      }
    },
  };
}

export function supabaseProductImageRepo(client: SupabaseClient): ProductImageRepo {
  return {
    async productExists(productId) {
      const { data, error } = await client
        .from('products')
        .select('id')
        .eq('id', productId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data !== null;
    },
    async listImages(productId) {
      const { data, error } = await client
        .from('product_images')
        .select(IMAGE_COLUMNS)
        .eq('product_id', productId)
        .order('sort_order')
        .order('created_at')
        .limit(MAX_IMAGES_PER_PRODUCT + 1);
      if (error) {
        throw error;
      }
      return (data ?? []) as ProductImageRow[];
    },
    async insertImage(row) {
      const { error } = await client.from('product_images').insert(row);
      if (error) {
        throw error;
      }
    },
    async updateImage(productId, imageId, patch) {
      const { data, error } = await client
        .from('product_images')
        .update(patch)
        .eq('id', imageId)
        .eq('product_id', productId)
        .select('id');
      if (error) {
        throw error;
      }
      return (data ?? []).length > 0;
    },
    async clearMain(productId) {
      const { error } = await client
        .from('product_images')
        .update({ is_main: false })
        .eq('product_id', productId)
        .eq('is_main', true);
      if (error) {
        throw error;
      }
    },
    async deleteImage(productId, imageId) {
      const { error } = await client
        .from('product_images')
        .delete()
        .eq('id', imageId)
        .eq('product_id', productId);
      if (error) {
        throw error;
      }
    },
    async audit(actor, action, productId, detail) {
      const { error } = await client.from('audit_log').insert({
        actor,
        action,
        subject_table: 'products',
        subject_id: productId,
        detail,
      });
      if (error) {
        throw error;
      }
    },
  };
}
