import { ImageResponse } from 'next/og';

import { BRAND_NAME } from '@forms/shared/brand';

import { OG_IMAGE_SIZE, ogImageAlt } from '@/lib/seo';
import {
  BRAND_HEX,
  WORDMARK_ASPECT,
  WORDMARK_LETTERS,
  WORDMARK_O,
  WORDMARK_O_OFFSET_X,
  WORDMARK_O_STROKE,
  WORDMARK_VIEWBOX,
  wordmarkHex,
} from '@/lib/wordmark';

/**
 * Social card for every public page. No text glyphs on purpose: the image
 * renderer would fall back to a font that is not Outfit or Manrope, so the
 * card is the wordmark (drawn from its paths) and the guard silhouette from
 * the home hero.
 */
export const alt = ogImageAlt(BRAND_NAME);
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';

// Same shell and slice positions as the home page Guard (page.tsx).
const SHELL =
  'M120 6C196 6 228 30 228 110C228 230 196 342 148 404C138 416 102 416 92 404C44 342 12 230 12 110C12 30 44 6 120 6Z';
const SLICES = [0.2, 0.4, 0.6, 0.8].map((f) => 413 - f * (413 - 6));

export default function OpengraphImage() {
  const mark = wordmarkHex('yellow');
  const markHeight = 120;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        background: BRAND_HEX.yellow,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <svg
        viewBox={WORDMARK_VIEWBOX}
        width={markHeight * WORDMARK_ASPECT}
        height={markHeight}
        style={{ marginLeft: 88 }}
      >
        <path d={WORDMARK_LETTERS} fill={mark.letters} />
        <path
          transform={`translate(${WORDMARK_O_OFFSET_X} 0)`}
          d={WORDMARK_O}
          fill="none"
          stroke={mark.o}
          strokeWidth={WORDMARK_O_STROKE}
        />
      </svg>
      <svg
        viewBox="0 0 240 420"
        width={420}
        height={735}
        style={{ position: 'absolute', right: -90, top: -40, transform: 'rotate(9deg)' }}
      >
        <path d={SHELL} fill={BRAND_HEX.brown} />
        {SLICES.map((y) => (
          <path
            key={y}
            d={`M24 ${y}Q120 ${y + 22} 216 ${y}`}
            fill="none"
            stroke={BRAND_HEX.yellow}
            strokeWidth={2}
          />
        ))}
        <rect x="113" y="40" width="14" height="330" rx="4" fill={BRAND_HEX.brightBrick} />
      </svg>
    </div>,
    { ...size },
  );
}
