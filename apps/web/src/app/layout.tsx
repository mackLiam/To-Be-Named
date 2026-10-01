import type { Metadata } from 'next';
import { Manrope, Outfit } from 'next/font/google';

import { BRAND_NAME } from '@forms/shared/brand';

import { getSiteUrl } from '@/lib/env';

import './globals.css';

// Self-hosted via next/font: fonts are downloaded and served from our own
// origin at build time, never fetched from Google at runtime. Outfit for
// display/headings, Manrope for body/UI (matches apps/app tokens).
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-body',
  display: 'swap',
});

const title = `${BRAND_NAME} - custom-fit shin guards`;
const description =
  'Shin guards molded to your leg. Scan with your iPhone, we generate the fit, we print and ship it.';

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl() ?? 'https://zells.com'),
  title,
  description,
  openGraph: { title, description, siteName: BRAND_NAME, type: 'website' },
  icons: {
    icon: [
      { url: '/brand/icon-brick.svg', type: 'image/svg+xml' },
      { url: '/brand/icon-brick-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/brand/icon-brick-180.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}
