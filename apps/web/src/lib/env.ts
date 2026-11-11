/**
 * Environment gating and hard security assertions.
 *
 * Every value is read through a function (never a module-load constant) so
 * that behavior tracks the current process.env at call time - this keeps the
 * fake-data fallback correct across server requests and makes the logic unit
 * testable by mutating process.env.
 *
 * Security invariant (CLAUDE.md gotcha 5, DESIGN.md section 9.2): the service
 * role key has full database access and must NEVER reach a client bundle. It
 * is read only from a plain (non NEXT_PUBLIC) variable, server-side. If anyone
 * ever defines a NEXT_PUBLIC_* variable that looks like a service key, we fail
 * loudly rather than ship it.
 */

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Fake-data mode: no backend is configured, so admin pages render clearly
 * labeled placeholder data and never attempt a network call. This is the
 * Phase 0/1 "runs with zero backend" guarantee, mirroring
 * apps/app/src/lib/api.ts USE_FAKE_DATA.
 */
export function isFakeMode(): boolean {
  // A deploy with the service key but a missing public var must fail closed:
  // fake mode lets admin routes through, and the STL route would then mint
  // real signed URLs with that key for anyone.
  return !hasSupabaseConfig() && !hasServiceRoleConfig();
}

/**
 * The service role client can only be built when a service key AND a
 * server-side Supabase URL are present. SUPABASE_URL is preferred; we fall
 * back to NEXT_PUBLIC_SUPABASE_URL for the URL only (a URL is not a secret).
 */
export function hasServiceRoleConfig(): boolean {
  return Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
  );
}

export function getServerSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export function getServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Comma-separated staff emails allowed into /admin. This is the only source of
 * admin authorization: it is server-held, so no user can grant it to
 * themselves. Do not move it into a user-writable table (see access.ts).
 */
export function getAdminAllowlist(): string[] {
  return (process.env.ADMIN_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const SERVICE_KEY_PATTERN = /SERVICE_ROLE|SERVICE_KEY|SECRET/i;

/**
 * Throws if any NEXT_PUBLIC_* variable looks like a server secret. Called at
 * the top of every server module that touches the service role, so a
 * misconfiguration fails the build/request instead of leaking a key into the
 * client bundle.
 */
export function assertNoPublicServiceKey(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEXT_PUBLIC_') && SERVICE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to start: ${key} is a NEXT_PUBLIC_* variable whose name looks ` +
          'like a server secret. Service keys must never be exposed to the client. ' +
          'Rename it to a non NEXT_PUBLIC variable (for example SUPABASE_SERVICE_ROLE_KEY).',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stripe checkout. All server-only: none of these may be NEXT_PUBLIC_*.
// ---------------------------------------------------------------------------

function commaList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getStripeSecretKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY || undefined;
}

export function getStripeWebhookSecret(): string | undefined {
  return process.env.STRIPE_WEBHOOK_SECRET || undefined;
}

/** Public origin of this site, no trailing slash. Checkout return pages live here. */
export function getSiteUrl(): string | undefined {
  return process.env.SITE_URL?.trim().replace(/\/+$/, '') || undefined;
}

/** Exact-match origins (scheme + host + port) allowed to call /api/checkout from a browser. */
export function getCheckoutAllowedOrigins(): string[] {
  return commaList(process.env.CHECKOUT_ALLOWED_ORIGINS);
}

/**
 * A checkout env variable holds a value that must not be used. Messages name
 * the variable and the rule, never the value.
 */
export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

// Stripe's own caps: 5 shipping options per Checkout Session.
export const MAX_SHIPPING_RATE_IDS = 5;
export const MAX_SHIPPING_COUNTRIES = 50;
const SHIPPING_RATE_ID = /^shr_[A-Za-z0-9]+$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

type Env = Record<string, string | undefined>;

/** Unset or empty is off, exactly "true" is on, anything else is a config error. */
function envFlag(env: Env, name: string): boolean {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  throw new EnvConfigError(`${name} must be exactly "true" or unset.`);
}

function strictList(
  env: Env,
  name: string,
  max: number,
  valid: (entry: string) => boolean,
  what: string,
): string[] {
  const entries = commaList(env[name]);
  if (entries.length > max) {
    throw new EnvConfigError(`${name} lists more than ${max} entries.`);
  }
  entries.forEach((entry, index) => {
    if (!valid(entry)) {
      throw new EnvConfigError(`${name} entry ${index + 1} is not ${what}.`);
    }
  });
  if (new Set(entries).size !== entries.length) {
    throw new EnvConfigError(`${name} lists the same entry twice.`);
  }
  return entries;
}

/**
 * ISO 3166-1 alpha-2 codes Stripe Checkout may ship to; US when unset.
 * Lowercase is accepted and uppercased, as before validation existed.
 */
export function getStripeShippingCountries(env: Env = process.env): string[] {
  const countries = strictList(
    { STRIPE_SHIPPING_COUNTRIES: env.STRIPE_SHIPPING_COUNTRIES?.toUpperCase() },
    'STRIPE_SHIPPING_COUNTRIES',
    MAX_SHIPPING_COUNTRIES,
    (c) => COUNTRY_CODE.test(c),
    'a two-letter ISO 3166-1 country code',
  );
  return countries.length > 0 ? countries : ['US'];
}

/**
 * Optional Stripe Checkout features, each OFF unless its variable is set.
 * Every one of them also needs Stripe dashboard setup (see .env.example), so
 * none may default on.
 */
export interface CheckoutGates {
  /** STRIPE_AUTOMATIC_TAX: Stripe Tax computes and adds tax. */
  automaticTax: boolean;
  /** STRIPE_SHIPPING_RATE_IDS: shipping rates offered, in order; empty means none. */
  shippingRateIds: readonly string[];
  /** STRIPE_TERMS_CONSENT: the customer must tick the terms of service box. */
  termsConsent: boolean;
  /** STRIPE_ALLOW_PROMOTION_CODES: the customer may enter a promotion code. */
  allowPromotionCodes: boolean;
}

export const CHECKOUT_GATES_OFF: CheckoutGates = Object.freeze({
  automaticTax: false,
  shippingRateIds: Object.freeze([]),
  termsConsent: false,
  allowPromotionCodes: false,
});

/** Throws EnvConfigError on any bad value; a typo never turns a gate on or off silently. */
export function getCheckoutGates(env: Env = process.env): CheckoutGates {
  return {
    automaticTax: envFlag(env, 'STRIPE_AUTOMATIC_TAX'),
    shippingRateIds: strictList(
      env,
      'STRIPE_SHIPPING_RATE_IDS',
      MAX_SHIPPING_RATE_IDS,
      (id) => SHIPPING_RATE_ID.test(id),
      'a Stripe shipping rate id (shr_ followed by letters and digits)',
    ),
    termsConsent: envFlag(env, 'STRIPE_TERMS_CONSENT'),
    allowPromotionCodes: envFlag(env, 'STRIPE_ALLOW_PROMOTION_CODES'),
  };
}
