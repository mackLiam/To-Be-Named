import { describe, expect, it } from 'vitest';

import { ogImageAlt, pageMetadata } from './seo';

describe('pageMetadata', () => {
  const meta = pageMetadata({
    title: 'Support - FORMS',
    description: 'Help with scanning.',
    path: '/support',
    siteName: 'FORMS',
  });

  it('repeats the page title and description in the social cards', () => {
    expect(meta.title).toBe('Support - FORMS');
    expect(meta.openGraph).toMatchObject({
      title: 'Support - FORMS',
      description: 'Help with scanning.',
      url: '/support',
      siteName: 'FORMS',
    });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image', title: 'Support - FORMS' });
  });

  it('names the card image on both cards', () => {
    const image = { url: '/opengraph-image', width: 1200, height: 630, alt: ogImageAlt('FORMS') };
    expect(meta.openGraph?.images).toEqual([image]);
    expect(meta.twitter?.images).toEqual([image]);
  });

  it('sets a canonical path', () => {
    expect(meta.alternates?.canonical).toBe('/support');
  });

  it('rejects a relative path', () => {
    expect(() =>
      pageMetadata({ title: 't', description: 'd', path: 'support', siteName: 'FORMS' }),
    ).toThrow();
  });
});
