import { BRAND_NAME } from '@forms/shared/brand';

import {
  WORDMARK_LETTERS,
  WORDMARK_O,
  WORDMARK_O_OFFSET_X,
  WORDMARK_O_STROKE,
  WORDMARK_VIEWBOX,
  wordmarkColors,
  type WordmarkSurface,
} from '@/lib/wordmark';

/**
 * The FORMS wordmark drawn from the designer's paths. `surface` is what it
 * sits on and picks the only allowed pairing. Size it with CSS height; the
 * width follows the viewBox. `decorative` hides it from assistive tech when
 * a parent link already carries the name.
 */
export function Wordmark({
  surface,
  className,
  decorative = false,
}: {
  surface: WordmarkSurface;
  className?: string;
  decorative?: boolean;
}) {
  const { letters, o } = wordmarkColors(surface);
  return (
    <svg
      viewBox={WORDMARK_VIEWBOX}
      className={className}
      focusable="false"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': BRAND_NAME })}
    >
      <path d={WORDMARK_LETTERS} fill={letters} />
      <path
        transform={`translate(${WORDMARK_O_OFFSET_X} 0)`}
        d={WORDMARK_O}
        fill="none"
        stroke={o}
        strokeWidth={WORDMARK_O_STROKE}
      />
    </svg>
  );
}
