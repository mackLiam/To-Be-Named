import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKOUT_GATES_OFF,
  EnvConfigError,
  MAX_SHIPPING_COUNTRIES,
  MAX_SHIPPING_RATE_IDS,
  assertNoPublicServiceKey,
  getAdminAllowlist,
  getCheckoutGates,
  getStripeShippingCountries,
  hasServiceRoleConfig,
  hasSupabaseConfig,
  isFakeMode,
} from './env';

const KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_ALLOWLIST',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('supabase config gating', () => {
  it('reports no config and fake mode when env is absent', () => {
    expect(hasSupabaseConfig()).toBe(false);
    expect(isFakeMode()).toBe(true);
  });

  it('reports config present when both public vars are set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    expect(hasSupabaseConfig()).toBe(true);
    expect(isFakeMode()).toBe(false);
  });

  it('is never fake mode while a service key is configured', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(hasSupabaseConfig()).toBe(false);
    expect(isFakeMode()).toBe(false);
  });

  it('needs a service key and a url for service role config', () => {
    expect(hasServiceRoleConfig()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(hasServiceRoleConfig()).toBe(false);
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    expect(hasServiceRoleConfig()).toBe(true);
  });
});

describe('admin allowlist parsing', () => {
  it('returns an empty list when unset', () => {
    expect(getAdminAllowlist()).toEqual([]);
  });

  it('splits, trims, and lowercases entries', () => {
    process.env.ADMIN_ALLOWLIST = ' Liam@Zells.com , ops@zells.com ,, ';
    expect(getAdminAllowlist()).toEqual(['liam@zells.com', 'ops@zells.com']);
  });
});

describe('assertNoPublicServiceKey', () => {
  it('passes for benign public vars', () => {
    expect(() =>
      assertNoPublicServiceKey({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      }),
    ).not.toThrow();
  });

  it('throws if a service key is exposed via NEXT_PUBLIC', () => {
    expect(() =>
      assertNoPublicServiceKey({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'leaked' }),
    ).toThrow(/never be exposed/i);
  });

  it('throws for a NEXT_PUBLIC secret of any name', () => {
    expect(() => assertNoPublicServiceKey({ NEXT_PUBLIC_STRIPE_SECRET: 'leaked' })).toThrow();
  });
});

describe('checkout gates', () => {
  const FLAGS = [
    ['STRIPE_AUTOMATIC_TAX', 'automaticTax'],
    ['STRIPE_TERMS_CONSENT', 'termsConsent'],
    ['STRIPE_ALLOW_PROMOTION_CODES', 'allowPromotionCodes'],
  ] as const;

  it('is all off with nothing set, and with every variable empty', () => {
    expect(getCheckoutGates({})).toEqual(CHECKOUT_GATES_OFF);
    expect(
      getCheckoutGates({
        STRIPE_AUTOMATIC_TAX: '',
        STRIPE_SHIPPING_RATE_IDS: '',
        STRIPE_TERMS_CONSENT: '',
        STRIPE_ALLOW_PROMOTION_CODES: ' ',
      }),
    ).toEqual(CHECKOUT_GATES_OFF);
  });

  it('reads process.env by default', () => {
    const before = process.env.STRIPE_TERMS_CONSENT;
    process.env.STRIPE_TERMS_CONSENT = 'true';
    try {
      expect(getCheckoutGates().termsConsent).toBe(true);
    } finally {
      if (before === undefined) {
        delete process.env.STRIPE_TERMS_CONSENT;
      } else {
        process.env.STRIPE_TERMS_CONSENT = before;
      }
    }
  });

  it.each(FLAGS)('%s turns on only its own gate with "true"', (name, field) => {
    expect(getCheckoutGates({ [name]: 'true' })).toEqual({ ...CHECKOUT_GATES_OFF, [field]: true });
    expect(getCheckoutGates({ [name]: ' true ' })[field]).toBe(true);
  });

  it.each(
    FLAGS.flatMap(([name]) =>
      ['TRUE', 'True', '1', 'yes', 'on', 'false', '0', 'true,true'].map((v) => [name, v] as const),
    ),
  )('%s rejects %j', (name, value) => {
    expect(() => getCheckoutGates({ [name]: value })).toThrow(EnvConfigError);
    expect(() => getCheckoutGates({ [name]: value })).toThrow(
      new RegExp(`^${name} must be exactly "true" or unset\\.$`),
    );
  });

  it('parses shipping rate ids in order, trimming and skipping empty entries', () => {
    expect(
      getCheckoutGates({ STRIPE_SHIPPING_RATE_IDS: ' shr_1AbC , shr_Zz9,' }).shippingRateIds,
    ).toEqual(['shr_1AbC', 'shr_Zz9']);
  });

  it('accepts exactly the maximum number of shipping rate ids', () => {
    const ids = Array.from({ length: MAX_SHIPPING_RATE_IDS }, (_, i) => `shr_r${i}`);
    expect(getCheckoutGates({ STRIPE_SHIPPING_RATE_IDS: ids.join(',') }).shippingRateIds).toEqual(
      ids,
    );
  });

  it.each([
    ['a non-shr id', 'shr_ok,price_123', /entry 2 is not a Stripe shipping rate id/],
    ['a bare prefix', 'shr_', /entry 1 is not/],
    ['a punctuated id', 'shr_ab-cd', /entry 1 is not/],
    ['an uppercase prefix', 'SHR_abc', /entry 1 is not/],
    ['a space inside an id', 'shr_a b', /entry 1 is not/],
    ['a duplicate', 'shr_a,shr_a', /same entry twice/],
    [
      'too many ids',
      Array.from({ length: MAX_SHIPPING_RATE_IDS + 1 }, (_, i) => `shr_r${i}`).join(','),
      /more than 5 entries/,
    ],
  ])('rejects %s in STRIPE_SHIPPING_RATE_IDS', (_label, value, message) => {
    expect(() => getCheckoutGates({ STRIPE_SHIPPING_RATE_IDS: value })).toThrow(EnvConfigError);
    expect(() => getCheckoutGates({ STRIPE_SHIPPING_RATE_IDS: value })).toThrow(message);
    expect(() => getCheckoutGates({ STRIPE_SHIPPING_RATE_IDS: value })).toThrow(
      /^STRIPE_SHIPPING_RATE_IDS /,
    );
  });

  it('never echoes the offending value in the error', () => {
    const secretish = 'sk_live_DO_NOT_LOG_ME';
    for (const env of [
      { STRIPE_AUTOMATIC_TAX: secretish },
      { STRIPE_TERMS_CONSENT: secretish },
      { STRIPE_ALLOW_PROMOTION_CODES: secretish },
      { STRIPE_SHIPPING_RATE_IDS: `shr_ok,${secretish}` },
      { STRIPE_SHIPPING_COUNTRIES: secretish },
    ]) {
      let message = '';
      try {
        getCheckoutGates(env);
        getStripeShippingCountries(env);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).toMatch(new RegExp(`^${Object.keys(env)[0]} `));
      expect(message.toLowerCase()).not.toContain(secretish.toLowerCase());
      expect(message).not.toContain('DO_NOT_LOG');
    }
  });
});

describe('STRIPE_SHIPPING_COUNTRIES', () => {
  it('defaults to US when unset or empty', () => {
    expect(getStripeShippingCountries({})).toEqual(['US']);
    expect(getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: '' })).toEqual(['US']);
    expect(getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: ' , ' })).toEqual(['US']);
  });

  it('keeps the existing parsing for valid values: trimmed, uppercased, in order', () => {
    expect(getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: 'US' })).toEqual(['US']);
    expect(getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: ' us, Ca ,GB' })).toEqual([
      'US',
      'CA',
      'GB',
    ]);
  });

  it('accepts exactly the maximum number of countries', () => {
    const codes = Array.from({ length: MAX_SHIPPING_COUNTRIES }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
    );
    expect(getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: codes.join(',') })).toEqual(
      codes,
    );
  });

  it.each([
    ['a three-letter code', 'US,USA', /entry 2 is not a two-letter ISO 3166-1 country code/],
    ['a one-letter code', 'U', /entry 1 is not/],
    ['a numeric code', '840', /entry 1 is not/],
    ['a country name', 'United States', /entry 1 is not/],
    ['a space-separated list', 'US CA', /entry 1 is not/],
    ['a duplicate', 'US,us', /same entry twice/],
    [
      'too many codes',
      Array.from({ length: MAX_SHIPPING_COUNTRIES + 1 }, (_, i) =>
        String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
      ).join(','),
      /more than 50 entries/,
    ],
  ])('rejects %s', (_label, value, message) => {
    expect(() => getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: value })).toThrow(
      EnvConfigError,
    );
    expect(() => getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: value })).toThrow(message);
    expect(() => getStripeShippingCountries({ STRIPE_SHIPPING_COUNTRIES: value })).toThrow(
      /^STRIPE_SHIPPING_COUNTRIES /,
    );
  });
});
