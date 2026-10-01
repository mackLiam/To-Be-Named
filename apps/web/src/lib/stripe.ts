import 'server-only';

import Stripe from 'stripe';

import { assertNoPublicServiceKey, getStripeSecretKey } from './env';

/**
 * The API version stripe@23.0.0 declares as its default. Pinned so a package
 * bump never silently changes webhook payload shapes (for example where
 * Checkout puts shipping details); the type is the package's LatestApiVersion,
 * so a bump that moves the default fails typecheck here until re-pinned.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive' as const;

/**
 * Server-only Stripe client. The secret key is read from a plain (non
 * NEXT_PUBLIC) variable; 'server-only' makes importing this from a client
 * component a build error. Callers gate on getStripeSecretKey() first.
 */
export function createStripeClient(): Stripe {
  assertNoPublicServiceKey();
  const key = getStripeSecretKey();
  if (!key) {
    throw new Error('createStripeClient called without STRIPE_SECRET_KEY.');
  }
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
}
