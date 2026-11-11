/**
 * Shop catalog rules, mirroring apps/web/src/lib/catalog.ts. SQL side:
 * migrations 0022 (availability, sizing_modes, display_order) and 0023
 * (product_images). Change them in lockstep. Pure, no IO.
 */

export type Availability = 'available' | 'coming_soon' | 'paused';
export type SizingMode = 'custom' | 'preset_s' | 'preset_m' | 'preset_l';

export interface ProductImageRow {
  storage_path: string;
  alt_text: string;
  is_main: boolean;
}

export const PRODUCT_IMAGES_BUCKET = 'product-images';

/** The only mode the scan-based checkout can fulfil (0022). */
const CHECKOUT_SIZING_MODE: SizingMode = 'custom';

export function isPurchasable(p: {
  availability: string;
  sizing_modes: readonly string[];
}): boolean {
  return p.availability === 'available' && p.sizing_modes.includes(CHECKOUT_SIZING_MODE);
}

/** display_order ascending, then name. */
export function compareShopOrder(
  a: { display_order: number; name: string },
  b: { display_order: number; name: string },
): number {
  return a.display_order - b.display_order || a.name.localeCompare(b.name, 'en');
}

export interface MainImage {
  uri: string;
  alt: string;
}

/**
 * The uploaded main image (public bucket, 0023), else the legacy
 * products.image_url (0009), whose alt falls back to the product name.
 */
export function mainImage(
  p: { name: string; image_url: string | null; product_images?: readonly ProductImageRow[] | null },
  supabaseUrl: string | undefined,
): MainImage | null {
  const main = p.product_images?.find((image) => image.is_main);
  if (main && supabaseUrl) {
    const base = supabaseUrl.replace(/\/+$/, '');
    const path = main.storage_path.split('/').map(encodeURIComponent).join('/');
    return {
      uri: `${base}/storage/v1/object/public/${PRODUCT_IMAGES_BUCKET}/${path}`,
      alt: main.alt_text,
    };
  }
  if (p.image_url) {
    return { uri: p.image_url, alt: p.name };
  }
  return null;
}
