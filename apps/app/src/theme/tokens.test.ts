import { describe, expect, it } from 'vitest';

import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatio } from './contrast';
import { colors, fontFamily, radius, spacing, typography } from './tokens';

describe('brand colors', () => {
  it('pins the four FORMS palette colors from the designer', () => {
    expect(colors.yellow).toBe('#EDD27A');
    expect(colors.brick[500]).toBe('#B0362C');
    expect(colors.brown[900]).toBe('#3A2E26');
    expect(colors.brightBrick).toBe('#E0513F');
  });

  it('derives neutrals by tinting brown toward yellow, never pure gray', () => {
    for (const hex of Object.values(colors.brown)) {
      expect(hex).not.toMatch(/^#([0-9A-F]{2})\1\1$/i); // rejects R=G=B, e.g. #888888
    }
  });

  it('has no white in the palette', () => {
    const all = JSON.stringify(colors).toUpperCase();
    expect(all).not.toContain('#FFFFFF');
  });
});

describe('contrast rules', () => {
  const pairs: [string, string, string][] = [
    ['primary text on yellow', colors.textPrimary, colors.background],
    ['primary text on muted surface', colors.textPrimary, colors.surfaceMuted],
    ['secondary text on yellow', colors.textSecondary, colors.background],
    ['secondary text on muted surface', colors.textSecondary, colors.surfaceMuted],
    ['tertiary text on yellow', colors.textTertiary, colors.background],
    ['tertiary text on muted surface', colors.textTertiary, colors.surfaceMuted],
    ['primary button label (yellow on action fill)', colors.onAction, colors.action],
    ['pressed primary button label', colors.onAction, colors.actionPressed],
    ['small action text on yellow', colors.action, colors.background],
    ['secondary button label (yellow on brown)', colors.onDark, colors.surfaceDark],
    ['pressed secondary button label', colors.onDark, colors.brown[700]],
    ['muted text on dark sections', colors.onDarkMuted, colors.surfaceDark],
    ['failure text on yellow', colors.danger, colors.background],
    ['failure text on muted surface', colors.danger, colors.surfaceMuted],
    ['yellow text on failure fill', colors.yellow, colors.danger],
  ];

  it.each(pairs)('passes AA normal text: %s', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('passes AA large text for bright brick accents on brown', () => {
    expect(contrastRatio(colors.accentOnDark, colors.surfaceDark)).toBeGreaterThanOrEqual(
      AA_LARGE_TEXT,
    );
  });

  it('passes AA large text for brand brick display type on yellow', () => {
    expect(contrastRatio(colors.brick[500], colors.background)).toBeGreaterThanOrEqual(
      AA_LARGE_TEXT,
    );
  });

  it('keeps brand brick 500 out of small text (fails normal AA with yellow)', () => {
    // Guardrail for "action is brick 600, not 500": if this starts passing,
    // the palette changed and brick 500 may be usable as the action fill.
    expect(contrastRatio(colors.brick[500], colors.yellow)).toBeLessThan(AA_NORMAL_TEXT);
    expect(colors.action).not.toBe(colors.brick[500]);
  });

  it('never allows bright brick on yellow (fails even large-text AA)', () => {
    // Guardrail for the "bright brick on brown only" brand rule: if this ever
    // starts passing, the palette changed and the rule needs re-checking.
    expect(contrastRatio(colors.brightBrick, colors.yellow)).toBeLessThan(AA_LARGE_TEXT);
  });

  it('keeps the failure color visibly distinct from the brand brick', () => {
    expect(contrastRatio(colors.danger, colors.brick[500])).toBeGreaterThanOrEqual(1.5);
    expect(contrastRatio(colors.danger, colors.action)).toBeGreaterThanOrEqual(1.4);
  });
});

describe('radius', () => {
  it('is a single small value (rectangles, not pills)', () => {
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThanOrEqual(8);
  });
});

describe('spacing scale', () => {
  it('is strictly increasing and covers the expected steps', () => {
    const steps = Object.values(spacing);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length); // no duplicate steps
    expect(Object.keys(spacing)).toEqual(['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl']);
  });
});

describe('typography', () => {
  it('uses Outfit for display/heading levels and Manrope for body levels', () => {
    expect(typography.display.fontFamily).toBe(fontFamily.display);
    expect(typography.h1.fontFamily).toContain('Outfit');
    expect(typography.h2.fontFamily).toContain('Outfit');
    expect(typography.h3.fontFamily).toContain('Outfit');
    expect(typography.body.fontFamily).toContain('Manrope');
    expect(typography.bodySmall.fontFamily).toContain('Manrope');
    expect(typography.caption.fontFamily).toContain('Manrope');
    expect(typography.button.fontFamily).toContain('Manrope');
  });

  it('has a large jump between body text and the smallest heading', () => {
    expect(typography.h3.fontSize - typography.body.fontSize).toBeGreaterThanOrEqual(4);
    expect(typography.display.fontSize - typography.h1.fontSize).toBeGreaterThanOrEqual(8);
  });
});
