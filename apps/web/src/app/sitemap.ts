import type { MetadataRoute } from 'next';

import { getSiteUrl } from '@/lib/env';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl() ?? 'https://zells.com';
  return ['/', '/privacy', '/terms', '/support'].map((path) => ({
    url: path === '/' ? base : `${base}${path}`,
  }));
}
