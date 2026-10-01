import type { MetadataRoute } from 'next';

import { getSiteUrl } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/login', '/api', '/checkout'] },
    sitemap: `${getSiteUrl() ?? 'https://zells.com'}/sitemap.xml`,
  };
}
