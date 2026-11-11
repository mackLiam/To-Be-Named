import type { SupabaseClient } from '@supabase/supabase-js';

import { PRODUCT_LIST_LIMIT, compareShopOrder, planMove, type MoveDirection } from './catalog';
import { checkOrderTransition, type ProductInput } from './shop';

/**
 * Admin mutations for the shop. Every function takes the SERVICE ROLE client
 * (the caller builds it, server-side only) and writes one audit_log row per
 * change: catalog edits and order moves must be attributable (apps/web
 * CLAUDE.md "Privilege model"). Expected refusals come back as { error } for
 * the form to show; anything else throws.
 *
 * ponytail: the change and its audit row are two statements, not one
 * transaction. If the audit insert fails the change stands and the action
 * throws, so the admin sees the failure; move both into one RPC if that ever
 * happens in practice.
 */

export type WriteResult = { error: string | null };

const OK: WriteResult = { error: null };

async function audit(
  client: SupabaseClient,
  actor: string,
  action: string,
  subjectTable: 'products' | 'orders',
  subjectId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('audit_log').insert({
    actor,
    action,
    subject_table: subjectTable,
    subject_id: subjectId,
    detail,
  });
  if (error) {
    throw error;
  }
}

function slugTaken(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

export async function createProduct(
  client: SupabaseClient,
  actor: string,
  input: ProductInput,
): Promise<WriteResult & { id?: string }> {
  const { data, error } = await client.from('products').insert(input).select('id').single();
  if (slugTaken(error)) {
    return { error: `Slug "${input.slug}" is already used by another product.` };
  }
  if (error) {
    throw error;
  }
  await audit(client, actor, 'product.create', 'products', data.id, { ...input });
  return { error: null, id: data.id };
}

export async function updateProduct(
  client: SupabaseClient,
  actor: string,
  id: string,
  input: ProductInput,
): Promise<WriteResult> {
  const { data, error } = await client.from('products').update(input).eq('id', id).select('id');
  if (slugTaken(error)) {
    return { error: `Slug "${input.slug}" is already used by another product.` };
  }
  if (error) {
    throw error;
  }
  if (!data?.length) {
    return { error: 'Product not found.' };
  }
  await audit(client, actor, 'product.update', 'products', id, { ...input });
  return OK;
}

export async function setProductActive(
  client: SupabaseClient,
  actor: string,
  id: string,
  active: boolean,
): Promise<WriteResult> {
  const { data, error } = await client
    .from('products')
    .update({ active })
    .eq('id', id)
    .select('id');
  if (error) {
    throw error;
  }
  if (!data?.length) {
    return { error: 'Product not found.' };
  }
  await audit(client, actor, active ? 'product.activate' : 'product.deactivate', 'products', id, {
    active,
  });
  return OK;
}

/**
 * Move a product one step up or down the shop order. The list is renumbered
 * 0..n-1 on the first move, then each move rewrites just the two swapped rows.
 *
 * ponytail: the rewrites are separate statements; a failure midway leaves a
 * valid (just different) order, which the next move renormalizes.
 */
export async function moveProduct(
  client: SupabaseClient,
  actor: string,
  id: string,
  direction: MoveDirection,
): Promise<WriteResult> {
  const { data, error } = await client
    .from('products')
    .select('id, name, display_order')
    .order('display_order')
    .order('name')
    .limit(PRODUCT_LIST_LIMIT);
  if (error) {
    throw error;
  }
  const rows = ((data ?? []) as { id: string; name: string; display_order: number }[]).sort(
    compareShopOrder,
  );
  if (!rows.some((row) => row.id === id)) {
    return { error: 'Product not found.' };
  }
  const changes = planMove(
    rows.map((row) => ({ id: row.id, order: row.display_order })),
    id,
    direction,
  );
  for (const change of changes) {
    const { error: updateError } = await client
      .from('products')
      .update({ display_order: change.order })
      .eq('id', change.id);
    if (updateError) {
      throw updateError;
    }
  }
  if (changes.length > 0) {
    await audit(client, actor, 'product.reorder', 'products', id, {
      direction,
      changes: changes.map((c) => ({ id: c.id, display_order: c.order })),
    });
  }
  return OK;
}

export async function updateOrderTracking(
  client: SupabaseClient,
  actor: string,
  id: string,
  tracking: { tracking_carrier: string | null; tracking_number: string | null },
): Promise<WriteResult> {
  const { data, error } = await client.from('orders').update(tracking).eq('id', id).select('id');
  if (error) {
    throw error;
  }
  if (!data?.length) {
    return { error: 'Order not found.' };
  }
  await audit(client, actor, 'order.tracking', 'orders', id, tracking);
  return OK;
}

/**
 * Move an order to `to`. The update is conditional on the status the rules
 * were checked against, so two admins clicking at once cannot both win, and
 * a webhook that moved the order meanwhile is never overwritten.
 */
export async function transitionOrder(
  client: SupabaseClient,
  actor: string,
  id: string,
  to: string,
): Promise<WriteResult> {
  const { data: order, error: readError } = await client
    .from('orders')
    .select('status, tracking_number')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    throw readError;
  }
  if (!order) {
    return { error: 'Order not found.' };
  }

  const refusal = checkOrderTransition(order.status, to, { trackingNumber: order.tracking_number });
  if (refusal) {
    return { error: refusal };
  }

  const { data, error } = await client
    .from('orders')
    .update({ status: to })
    .eq('id', id)
    .eq('status', order.status)
    .select('id');
  // check_violation: the orders_enqueue_cad trigger (migration 0008) refuses
  // 'paid' when a scan has no measurements or the product has no cad_model.
  // Its message says which, so the admin sees it instead of a crash.
  if (error?.code === '23514') {
    return { error: error.message };
  }
  if (error) {
    throw error;
  }
  if (!data?.length) {
    return { error: 'The order changed while you were looking at it. Reload and try again.' };
  }
  await audit(client, actor, 'order.status', 'orders', id, { from: order.status, to });
  return OK;
}
