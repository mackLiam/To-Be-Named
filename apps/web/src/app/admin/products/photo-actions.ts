'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/admin-auth';
import { errorCode, flashPath } from '@/lib/admin-messages';
import { isMoveDirection } from '@/lib/catalog';
import { shouldUseFake } from '@/lib/data';
import {
  deleteProductImage,
  moveImage,
  setMainImage,
  supabaseImageStorage,
  supabaseProductImageRepo,
  updateImageAlt,
} from '@/lib/product-image-writes';
import { isUuid } from '@/lib/shop';
import { createServiceRoleClient } from '@/lib/supabase-admin';

/**
 * Photo management server actions (upload is the route handler at
 * app/admin/api/products/[id]/images, because server actions cap bodies at
 * 1 MB). Each action gates on requireAdmin() itself: a server action is a
 * public POST endpoint. Rules live in lib/product-image-writes.ts.
 */

const READ_ONLY = 'Read-only: no service role is configured, so changes cannot be saved.';

function done(productId: string, error: string | null): never {
  const path = `/admin/products/${productId}`;
  revalidatePath(path);
  revalidatePath('/admin/products');
  redirect(flashPath(path, { error: errorCode(error, 'action_failed') }, '#photos'));
}

/** Admin gate first, then the ids every photo action needs. */
async function photoContext(formData: FormData) {
  const ctx = await requireAdmin();
  const productId = String(formData.get('product_id') ?? '');
  const imageId = String(formData.get('image_id') ?? '');
  if (!isUuid(productId)) {
    redirect(flashPath('/admin/products', { error: 'unknown_product' }));
  }
  if (!isUuid(imageId)) {
    done(productId, 'Unknown photo.');
  }
  if (ctx.fake || shouldUseFake()) {
    done(productId, READ_ONLY);
  }
  const client = createServiceRoleClient();
  return {
    actor: ctx.actor,
    productId: productId.toLowerCase(),
    imageId: imageId.toLowerCase(),
    repo: supabaseProductImageRepo(client),
    storage: supabaseImageStorage(client),
  };
}

export async function setMainPhoto(formData: FormData): Promise<void> {
  const c = await photoContext(formData);
  const result = await setMainImage(c.repo, c.actor, c.productId, c.imageId);
  done(c.productId, result.error);
}

export async function savePhotoAlt(formData: FormData): Promise<void> {
  const c = await photoContext(formData);
  const alt = formData.get('alt_text');
  const result = await updateImageAlt(
    c.repo,
    c.actor,
    c.productId,
    c.imageId,
    typeof alt === 'string' ? alt : null,
  );
  done(c.productId, result.error);
}

export async function movePhoto(formData: FormData): Promise<void> {
  const c = await photoContext(formData);
  const direction = String(formData.get('direction') ?? '');
  if (!isMoveDirection(direction)) {
    done(c.productId, 'Unknown direction.');
  }
  const result = await moveImage(c.repo, c.actor, c.productId, c.imageId, direction);
  done(c.productId, result.error);
}

export async function deletePhoto(formData: FormData): Promise<void> {
  const c = await photoContext(formData);
  const result = await deleteProductImage(c.repo, c.storage, c.actor, c.productId, c.imageId);
  done(c.productId, result.error);
}
