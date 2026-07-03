/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as its own turbo task (pnpm --filter @zells/web lint), so we
  // do not want `next build` to run ESLint a second time and couple the two.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // @zells/shared ships as compiled JS in dist/, so no transpilePackages needed.
};

export default nextConfig;
