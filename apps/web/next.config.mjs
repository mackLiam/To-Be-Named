// No script-src CSP: Next injects inline scripts that would need per-request
// nonces via middleware. frame-ancestors/base-uri/form-action/object-src are
// safe without them.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

// Staff pages carry minors' scan data and TOTP secrets: never cache, never index.
const privateHeaders = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Robots-Tag', value: 'noindex' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as its own turbo task (pnpm --filter @forms/web lint), so we
  // do not want `next build` to run ESLint a second time and couple the two.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // @forms/shared ships as compiled JS in dist/, so no transpilePackages needed.
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/admin/:path*', headers: privateHeaders },
      { source: '/login/:path*', headers: privateHeaders },
    ];
  },
};

export default nextConfig;
