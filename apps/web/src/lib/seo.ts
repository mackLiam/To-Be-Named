import type { Metadata } from 'next';

/**
 * Metadata for a public marketing page: title, description, canonical path,
 * and Open Graph and Twitter cards that repeat the page's own title (a page
 * that sets only `title` inherits the layout's Open Graph title otherwise).
 * The card image is app/opengraph-image.tsx. Next attaches it only to pages
 * that set no openGraph of their own, so it is named here explicitly.
 */
export const OG_IMAGE_PATH = '/opengraph-image';
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export function ogImageAlt(siteName: string): string {
  return `${siteName}: custom-fit soccer shin guards`;
}

export function pageMetadata({
  title,
  description,
  path,
  siteName,
}: {
  title: string;
  description: string;
  path: string;
  siteName: string;
}): Metadata {
  if (!path.startsWith('/')) {
    throw new Error(`pageMetadata path must start with "/": ${path}`);
  }
  const images = [{ url: OG_IMAGE_PATH, ...OG_IMAGE_SIZE, alt: ogImageAlt(siteName) }];
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName,
      type: 'website',
      locale: 'en_US',
      images,
    },
    twitter: { card: 'summary_large_image', title, description, images },
  };
}
