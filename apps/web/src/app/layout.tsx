import type { Metadata } from 'next';
import { Manrope, Outfit } from 'next/font/google';

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

export const metadata: Metadata = {
  title: 'Zells - custom-fit shin guards',
  description:
    'Shin guards molded to your leg. Scan with your iPhone, we generate the fit, we print and ship it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}
