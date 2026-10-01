'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/admin-auth';
import { emailDepsFromEnv, notifyOrderShipped } from '@/lib/email';
import { shouldUseFake } from '@/lib/data';
import { getStripeSecretKey, isFakeMode } from '@/lib/env';
import { refundOrder as refundOrderPayment } from '@/lib/refund';
import { isUuid, parseProductForm, parseTrackingForm } from '@/lib/shop';
import {
  createProduct,
  setProductActive,
  transitionOrder,
  updateOrderTracking,
  updateProduct,
} from '@/lib/shop-writes';
import { createStripeClient } from '@/lib/stripe';
import { createServiceRoleClient } from '@/lib/supabase-admin';
import { createAnonServerClient } from '@/lib/supabase-server';

/**
 * Admin server actions. Thin by rule (apps/web CLAUDE.md): each one gates on
 * requireAdmin() itself, because a server action is a public POST endpoint
 * and the page that rendered its form proves nothing. Validation and write
 * rules live in lib/shop.ts and lib/shop-writes.ts.
 */

const READ_ONLY = 'Read-only: no service role is configured, so changes cannot be saved.';

async function writer() {
  const ctx = await requireAdmin();
  if (ctx.fake || shouldUseFake()) {
    return null;
  }
  return { client: createServiceRoleClient(), actor: ctx.actor };
}

function fields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function back(path: string, error: string | null): never {
  redirect(error ? `${path}?error=${encodeURIComponent(error)}` : path);
}

export interface ProductFormState {
  errors: string[];
}

export async function saveProduct(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const w = await writer();
  if (!w) {
    return { errors: [READ_ONLY] };
  }
  const form = fields(formData);
  const id = form.id ?? '';
  if (id && !isUuid(id)) {
    return { errors: ['Unknown product.'] };
  }
  const parsed = parseProductForm(form);
  if (!parsed.ok) {
    return { errors: parsed.errors };
  }

  const result = id
    ? await updateProduct(w.client, w.actor, id, parsed.value)
    : await createProduct(w.client, w.actor, parsed.value);
  if (result.error) {
    return { errors: [result.error] };
  }
  revalidatePath('/admin/products');
  redirect('/admin/products');
}

export async function toggleProduct(formData: FormData): Promise<void> {
  const w = await writer();
  if (!w) {
    back('/admin/products', READ_ONLY);
  }
  const { id = '', active } = fields(formData);
  if (!isUuid(id)) {
    back('/admin/products', 'Unknown product.');
  }
  const result = await setProductActive(w.client, w.actor, id, active === 'true');
  revalidatePath('/admin/products');
  back('/admin/products', result.error);
}

export async function setOrderStatus(formData: FormData): Promise<void> {
  const { id = '', to = '' } = fields(formData);
  if (!isUuid(id)) {
    back('/admin/orders', 'Unknown order.');
  }
  const path = `/admin/orders/${id}`;
  const w = await writer();
  if (!w) {
    back(path, READ_ONLY);
  }
  const result = await transitionOrder(w.client, w.actor, id, to);
  if (!result.error && to === 'shipped') {
    // Best effort: notifyOrderShipped never throws, and a missed email must
    // not undo or block the status change.
    await notifyOrderShipped(w.client, id, emailDepsFromEnv());
  }
  revalidatePath(path);
  back(path, result.error);
}

export async function saveTracking(formData: FormData): Promise<void> {
  const form = fields(formData);
  const id = form.id ?? '';
  if (!isUuid(id)) {
    back('/admin/orders', 'Unknown order.');
  }
  const path = `/admin/orders/${id}`;
  const w = await writer();
  if (!w) {
    back(path, READ_ONLY);
  }
  const parsed = parseTrackingForm(form);
  if (!parsed.ok) {
    back(path, parsed.errors.join(' '));
  }
  const result = await updateOrderTracking(w.client, w.actor, id, parsed.value);
  revalidatePath(path);
  back(path, result.error);
}

export async function refundOrder(formData: FormData): Promise<void> {
  // Admin gate before anything else, including input parsing: this moves money.
  const w = await writer();
  const { id = '' } = fields(formData);
  if (!isUuid(id)) {
    back('/admin/orders', 'Unknown order.');
  }
  const path = `/admin/orders/${id}`;
  if (!w) {
    back(path, READ_ONLY);
  }
  if (!getStripeSecretKey()) {
    back(path, 'Refunds are unavailable: STRIPE_SECRET_KEY is not configured.');
  }
  const result = await refundOrderPayment(w.client, createStripeClient(), w.actor, id);
  revalidatePath(path);
  back(path, result.error);
}

export async function signOut(): Promise<void> {
  if (!isFakeMode()) {
    const supabase = await createAnonServerClient();
    await supabase.auth.signOut();
  }
  redirect('/login');
}
