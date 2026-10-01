/**
 * Order display helpers for the Orders tab. Pure, tested in orders.test.ts.
 */

/** The reference support and the order emails use: the first 8 characters
 * of the order id, upper case (apps/web src/lib/email.ts prints the same). */
export function orderReference(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

// Public tracking pages, keyed by the carrier name the admin types. Unknown
// carriers show the number without a link.
const TRACKING_URL: Record<string, (n: string) => string> = {
  ups: (n) => `https://www.ups.com/track?tracknum=${n}`,
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  dhl: (n) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${n}`,
};

export function trackingUrl(carrier: string | null, trackingNumber: string | null): string | null {
  const build = carrier
    ? TRACKING_URL[carrier.trim().toLowerCase().replace(/[\s.]/g, '')]
    : undefined;
  return build && trackingNumber ? build(encodeURIComponent(trackingNumber.trim())) : null;
}
