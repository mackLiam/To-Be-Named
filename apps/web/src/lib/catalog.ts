/**
 * Catalog rules shared by the admin panel, checkout and any shop listing:
 * availability states, sizing modes, shop visibility and order, reordering,
 * and which image the shop shows. Pure (no IO). The SQL side of the same
 * rules is migration 0022 (products read policy and check constraints) and
 * 0023 (product_images); change them in lockstep.
 */

import type { StatusMeta } from './view';

export const AVAILABILITIES = ['available', 'coming_soon', 'paused'] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export const AVAILABILITY_META: Record<Availability, StatusMeta & { hint: string }> = {
  available: { label: 'Available', tone: 'good', hint: 'Listed and purchasable.' },
  coming_soon: { label: 'Coming soon', tone: 'neutral', hint: 'Listed, not purchasable.' },
  paused: { label: 'Paused', tone: 'warn', hint: 'Hidden from the shop.' },
};

export function isAvailability(value: string | null | undefined): value is Availability {
  return value != null && (AVAILABILITIES as readonly string[]).includes(value);
}

/**
 * DESIGN.md 7a.3. A product row is one guard model tier (7a.1, 7a.2), so the
 * "tiers sold" per product are these sizing modes. Presets have no value sets
 * yet, so checkout sells custom only (CHECKOUT_SIZING_MODE).
 */
export const SIZING_MODES = ['custom', 'preset_s', 'preset_m', 'preset_l'] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

export const SIZING_MODE_LABEL: Record<SizingMode, string> = {
  custom: 'Custom fit (scan)',
  preset_s: 'Preset S',
  preset_m: 'Preset M',
  preset_l: 'Preset L',
};

/** The only mode the scan-based checkout can fulfil. */
export const CHECKOUT_SIZING_MODE: SizingMode = 'custom';

export function isSizingMode(value: string): value is SizingMode {
  return (SIZING_MODES as readonly string[]).includes(value);
}

/** Known modes only, deduplicated, in canonical order. */
export function normalizeSizingModes(values: readonly string[]): SizingMode[] {
  return SIZING_MODES.filter((mode) => values.includes(mode));
}

export interface ShopState {
  active: boolean;
  availability: string;
}

/** Listed in the shop: not archived and not paused (0022 read policy). */
export function isShopVisible(product: ShopState): boolean {
  return (
    product.active && isAvailability(product.availability) && product.availability !== 'paused'
  );
}

/** Buyable through checkout: listed, available, and sells custom fit. */
export function isPurchasable(product: ShopState & { sizing_modes: readonly string[] }): boolean {
  return (
    product.active &&
    product.availability === 'available' &&
    product.sizing_modes.includes(CHECKOUT_SIZING_MODE)
  );
}

/** Admin badge for a product's shop state: archived wins over availability. */
export function productStateMeta(product: ShopState): StatusMeta {
  if (!product.active) {
    return { label: 'Archived', tone: 'bad' };
  }
  return isAvailability(product.availability)
    ? AVAILABILITY_META[product.availability]
    : { label: product.availability, tone: 'neutral' };
}

/** "Custom fit (scan), Preset S" for the admin list; unknown values are dropped. */
export function sizingModesLabel(modes: readonly string[]): string {
  const known = normalizeSizingModes(modes);
  return known.length > 0 ? known.map((mode) => SIZING_MODE_LABEL[mode]).join(', ') : '-';
}

export interface Orderable {
  id: string;
  name: string;
  display_order: number;
}

/** Shop order: display_order ascending, then name, then id so ties are stable. */
export function compareShopOrder(a: Orderable, b: Orderable): number {
  return (
    a.display_order - b.display_order ||
    a.name.localeCompare(b.name, 'en') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** What the shop lists, in order, each flagged purchasable or not. */
export function shopListing<T extends Orderable & ShopState & { sizing_modes: readonly string[] }>(
  products: readonly T[],
): (T & { purchasable: boolean })[] {
  return products
    .filter(isShopVisible)
    .sort(compareShopOrder)
    .map((product) => ({ ...product, purchasable: isPurchasable(product) }));
}

// ponytail: the catalog is a handful of guard models; paginate if it passes this.
export const PRODUCT_LIST_LIMIT = 200;

export type MoveDirection = 'up' | 'down';

export function isMoveDirection(value: string | undefined): value is MoveDirection {
  return value === 'up' || value === 'down';
}

/**
 * Move one item a step within an already-sorted list and renumber the whole
 * list 0..n-1. Returns only rows whose order value changes, so a move that
 * swaps two neighbours writes two rows once the list is normalized. Empty
 * when the item is unknown or already at that end.
 */
export function planMove(
  sorted: readonly { id: string; order: number }[],
  id: string,
  direction: MoveDirection,
): { id: string; order: number }[] {
  const from = sorted.findIndex((row) => row.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= sorted.length) {
    return [];
  }
  const ids = sorted.map((row) => row.id);
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  const current = new Map(sorted.map((row) => [row.id, row.order]));
  return ids
    .map((rowId, index) => ({ id: rowId, order: index }))
    .filter((row) => current.get(row.id) !== row.order);
}

// ---------------------------------------------------------------------------
// Images.
// ---------------------------------------------------------------------------

export const PRODUCT_IMAGES_BUCKET = 'product-images';

/** Public object URL for a catalog photo (public bucket, 0023). */
export function productImagePublicUrl(supabaseUrl: string, storagePath: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  const path = storagePath.split('/').map(encodeURIComponent).join('/');
  return `${base}/storage/v1/object/public/${PRODUCT_IMAGES_BUCKET}/${path}`;
}

export interface ShopImage {
  src: string;
  alt: string;
}

/**
 * The image the shop shows: the uploaded main image, else the legacy
 * products.image_url (0009) while catalogs migrate. The legacy URL has no
 * alt text, so its alt is the product name.
 */
export function resolveShopImage(input: {
  main: { storage_path: string; alt_text: string } | null;
  imageUrl: string | null;
  productName: string;
  supabaseUrl: string | undefined;
}): ShopImage | null {
  if (input.main && input.supabaseUrl) {
    return {
      src: productImagePublicUrl(input.supabaseUrl, input.main.storage_path),
      alt: input.main.alt_text,
    };
  }
  if (input.imageUrl) {
    return { src: input.imageUrl, alt: input.productName };
  }
  return null;
}
