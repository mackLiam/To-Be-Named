import { describe, expect, it } from 'vitest';

import { compareShopOrder, isPurchasable, mainImage } from './catalog';

const URL = 'https://x.supabase.co';
const A = '11111111-1111-1111-1111-111111111111';

describe('isPurchasable', () => {
  it('needs available and custom sizing', () => {
    expect(isPurchasable({ availability: 'available', sizing_modes: ['custom'] })).toBe(true);
    expect(isPurchasable({ availability: 'available', sizing_modes: ['preset_m', 'custom'] })).toBe(
      true,
    );
  });
  it('refuses coming_soon, paused, unknown and preset-only', () => {
    expect(isPurchasable({ availability: 'coming_soon', sizing_modes: ['custom'] })).toBe(false);
    expect(isPurchasable({ availability: 'paused', sizing_modes: ['custom'] })).toBe(false);
    expect(isPurchasable({ availability: 'weird', sizing_modes: ['custom'] })).toBe(false);
    expect(isPurchasable({ availability: 'available', sizing_modes: ['preset_s'] })).toBe(false);
    expect(isPurchasable({ availability: 'available', sizing_modes: [] })).toBe(false);
  });
});

describe('compareShopOrder', () => {
  it('orders by display_order then name', () => {
    const rows = [
      { display_order: 2, name: 'A' },
      { display_order: 1, name: 'Z' },
      { display_order: 1, name: 'B' },
    ];
    expect(rows.sort(compareShopOrder).map((r) => r.name)).toEqual(['B', 'Z', 'A']);
  });
});

describe('mainImage', () => {
  const base = { name: 'Guard', image_url: null };
  it('returns null for a product with no images and no legacy url', () => {
    expect(mainImage({ ...base, product_images: [] }, URL)).toBeNull();
    expect(mainImage(base, URL)).toBeNull();
  });
  it('picks the main one of several images', () => {
    const product_images = [
      { storage_path: `${A}/a.jpg`, alt_text: 'Other', is_main: false },
      { storage_path: `${A}/b.png`, alt_text: 'Front view', is_main: true },
      { storage_path: `${A}/c.webp`, alt_text: 'Side', is_main: false },
    ];
    expect(mainImage({ ...base, product_images }, `${URL}/`)).toEqual({
      uri: `${URL}/storage/v1/object/public/product-images/${A}/b.png`,
      alt: 'Front view',
    });
  });
  it('falls back to image_url with the name as alt when no main image', () => {
    const product_images = [{ storage_path: `${A}/a.jpg`, alt_text: 'Other', is_main: false }];
    expect(
      mainImage({ name: 'Guard', image_url: 'https://e.com/g.jpg', product_images }, URL),
    ).toEqual({ uri: 'https://e.com/g.jpg', alt: 'Guard' });
  });
  it('falls back to image_url when the supabase url is unknown', () => {
    const product_images = [{ storage_path: `${A}/a.jpg`, alt_text: 'Main', is_main: true }];
    expect(
      mainImage({ name: 'G', image_url: 'https://e.com/g.jpg', product_images }, undefined),
    ).toEqual({ uri: 'https://e.com/g.jpg', alt: 'G' });
  });
});
