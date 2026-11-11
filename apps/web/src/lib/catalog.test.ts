import { describe, expect, it } from 'vitest';

import {
  AVAILABILITIES,
  AVAILABILITY_META,
  SIZING_MODES,
  SIZING_MODE_LABEL,
  compareShopOrder,
  isMoveDirection,
  isPurchasable,
  isShopVisible,
  normalizeSizingModes,
  planMove,
  productImagePublicUrl,
  productStateMeta,
  sizingModesLabel,
  resolveShopImage,
  shopListing,
} from './catalog';

function product(
  id: string,
  patch: Partial<{
    name: string;
    display_order: number;
    active: boolean;
    availability: string;
    sizing_modes: string[];
  }> = {},
) {
  return {
    id,
    name: id.toUpperCase(),
    display_order: 0,
    active: true,
    availability: 'available',
    sizing_modes: ['custom'],
    ...patch,
  };
}

describe('constants', () => {
  it('match the 0022 check constraints', () => {
    expect([...AVAILABILITIES]).toEqual(['available', 'coming_soon', 'paused']);
    expect([...SIZING_MODES]).toEqual(['custom', 'preset_s', 'preset_m', 'preset_l']);
    expect(Object.keys(AVAILABILITY_META).sort()).toEqual([...AVAILABILITIES].sort());
    expect(Object.keys(SIZING_MODE_LABEL).sort()).toEqual([...SIZING_MODES].sort());
  });
});

describe('isShopVisible and isPurchasable', () => {
  it.each([
    ['available', true, true, true],
    ['coming_soon', true, true, false],
    ['paused', true, false, false],
    ['available', false, false, false],
    ['coming_soon', false, false, false],
    ['sold_out', true, false, false],
  ])('%s active=%s -> visible %s, purchasable %s', (availability, active, visible, buyable) => {
    const p = product('a', { availability, active });
    expect(isShopVisible(p)).toBe(visible);
    expect(isPurchasable(p)).toBe(buyable);
  });

  it('needs custom fit to be purchasable through checkout', () => {
    expect(isPurchasable(product('a', { sizing_modes: ['preset_s', 'preset_m'] }))).toBe(false);
    expect(isPurchasable(product('a', { sizing_modes: ['preset_s', 'custom'] }))).toBe(true);
  });
});

describe('shopListing', () => {
  it('drops paused and archived, sorts by display order then name, flags purchasable', () => {
    const listing = shopListing([
      product('c', { display_order: 2 }),
      product('b', { display_order: 1, availability: 'coming_soon' }),
      product('p', { display_order: 0, availability: 'paused' }),
      product('x', { display_order: 0, active: false }),
      product('a', { display_order: 1 }),
    ]);
    expect(listing.map((p) => [p.id, p.purchasable])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('breaks full ties by id so the order is stable', () => {
    const a = product('2', { name: 'Same' });
    const b = product('1', { name: 'Same' });
    expect([a, b].sort(compareShopOrder).map((p) => p.id)).toEqual(['1', '2']);
  });

  it('is empty for an empty catalog', () => {
    expect(shopListing([])).toEqual([]);
  });
});

describe('normalizeSizingModes', () => {
  it('keeps known modes once, in canonical order', () => {
    expect(normalizeSizingModes(['preset_l', 'bogus', 'custom', 'custom'])).toEqual([
      'custom',
      'preset_l',
    ]);
    expect(normalizeSizingModes([])).toEqual([]);
  });
});

describe('planMove', () => {
  const rows = (orders: number[]) => orders.map((order, i) => ({ id: `r${i}`, order }));

  it('swaps neighbours in an already normalized list', () => {
    expect(planMove(rows([0, 1, 2]), 'r1', 'up')).toEqual([
      { id: 'r1', order: 0 },
      { id: 'r0', order: 1 },
    ]);
    expect(planMove(rows([0, 1, 2]), 'r1', 'down')).toEqual([
      { id: 'r2', order: 1 },
      { id: 'r1', order: 2 },
    ]);
  });

  it('renumbers ties and gaps while moving', () => {
    expect(planMove(rows([0, 0, 0]), 'r2', 'up')).toEqual([
      { id: 'r2', order: 1 },
      { id: 'r1', order: 2 },
    ]);
    expect(planMove(rows([5, 10]), 'r0', 'down')).toEqual([
      { id: 'r1', order: 0 },
      { id: 'r0', order: 1 },
    ]);
  });

  it('is a no-op at either end or for an unknown id', () => {
    expect(planMove(rows([0, 1]), 'r0', 'up')).toEqual([]);
    expect(planMove(rows([0, 1]), 'r1', 'down')).toEqual([]);
    expect(planMove(rows([0, 1]), 'nope', 'up')).toEqual([]);
    expect(planMove([], 'r0', 'down')).toEqual([]);
  });

  it('validates directions from form input', () => {
    expect(isMoveDirection('up')).toBe(true);
    expect(isMoveDirection('down')).toBe(true);
    expect(isMoveDirection('left')).toBe(false);
    expect(isMoveDirection(undefined)).toBe(false);
  });
});

describe('images', () => {
  const PATH = '00000000-0000-4000-8000-0000000000c1/00000000-0000-4000-8000-0000000000e1.jpg';

  it('builds the public bucket URL', () => {
    expect(productImagePublicUrl('https://abc.supabase.co/', PATH)).toBe(
      `https://abc.supabase.co/storage/v1/object/public/product-images/${PATH}`,
    );
  });

  it('prefers the main image, then the legacy image_url, then nothing', () => {
    const main = { storage_path: PATH, alt_text: 'Front view' };
    expect(
      resolveShopImage({
        main,
        imageUrl: 'https://cdn.example/old.jpg',
        productName: 'Guard',
        supabaseUrl: 'https://abc.supabase.co',
      }),
    ).toEqual({
      src: `https://abc.supabase.co/storage/v1/object/public/product-images/${PATH}`,
      alt: 'Front view',
    });
    expect(
      resolveShopImage({
        main: null,
        imageUrl: 'https://cdn.example/old.jpg',
        productName: 'Guard',
        supabaseUrl: 'https://abc.supabase.co',
      }),
    ).toEqual({ src: 'https://cdn.example/old.jpg', alt: 'Guard' });
    expect(
      resolveShopImage({
        main: null,
        imageUrl: null,
        productName: 'Guard',
        supabaseUrl: undefined,
      }),
    ).toBeNull();
  });

  it('falls back when no Supabase URL is configured (fake mode)', () => {
    expect(
      resolveShopImage({
        main: { storage_path: PATH, alt_text: 'x' },
        imageUrl: null,
        productName: 'Guard',
        supabaseUrl: undefined,
      }),
    ).toBeNull();
  });
});

describe('admin labels', () => {
  it('shows archived over availability, and each availability otherwise', () => {
    expect(productStateMeta({ active: false, availability: 'available' }).label).toBe('Archived');
    expect(productStateMeta({ active: true, availability: 'coming_soon' }).label).toBe(
      'Coming soon',
    );
    expect(productStateMeta({ active: true, availability: 'paused' }).tone).toBe('warn');
    expect(productStateMeta({ active: true, availability: 'odd' })).toEqual({
      label: 'odd',
      tone: 'neutral',
    });
  });

  it('lists sizing modes in canonical order', () => {
    expect(sizingModesLabel(['preset_s', 'custom'])).toBe('Custom fit (scan), Preset S');
    expect(sizingModesLabel([])).toBe('-');
  });
});
