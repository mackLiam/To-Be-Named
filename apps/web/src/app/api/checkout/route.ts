import { createClient } from '@supabase/supabase-js';

import {
  MAX_CHECKOUT_BODY_BYTES,
  corsHeaders,
  handleCheckout,
  preflightHeaders,
  readCappedText,
  supabaseCheckoutStore,
  type CheckoutUser,
} from '@/lib/checkout';
import {
  getCheckoutAllowedOrigins,
  getSiteUrl,
  getStripeSecretKey,
  getStripeShippingCountries,
  hasServiceRoleConfig,
  hasSupabaseConfig,
} from '@/lib/env';
import { createStripeClient } from '@/lib/stripe';
import { createServiceRoleClient } from '@/lib/supabase-admin';

/**
 * Thin adapter over handleCheckout (lib/checkout.ts, unit tested): wires the
 * anon client for token verification, the SERVICE ROLE store and Stripe.
 */

export const dynamic = 'force-dynamic';

async function verifyToken(token: string): Promise<CheckoutUser | null> {
  // Anon key only: getUser(token) asks the Auth server to validate the JWT.
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    is_anonymous: data.user.is_anonymous === true,
  };
}

export function OPTIONS(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: preflightHeaders(request.headers.get('origin'), getCheckoutAllowedOrigins()),
  });
}

export async function POST(request: Request): Promise<Response> {
  const headers = {
    ...corsHeaders(request.headers.get('origin'), getCheckoutAllowedOrigins()),
    'Cache-Control': 'no-store',
  };
  const siteUrl = getSiteUrl();

  let result;
  try {
    result = await handleCheckout({
      authorization: request.headers.get('authorization'),
      rawBody: await readCappedText(request.body, MAX_CHECKOUT_BODY_BYTES),
      config: {
        configured: Boolean(
          getStripeSecretKey() && hasSupabaseConfig() && hasServiceRoleConfig() && siteUrl,
        ),
        siteUrl: siteUrl ?? '',
        shippingCountries: getStripeShippingCountries(),
      },
      verifyToken,
      getStore: () => supabaseCheckoutStore(createServiceRoleClient()),
      getStripe: () => createStripeClient(),
    });
  } catch (err) {
    console.error('checkout failed:', err instanceof Error ? err.message : 'unknown error');
    result = { status: 500, body: { error: 'internal_error' } };
  }

  return Response.json(result.body, { status: result.status, headers });
}
