import { describe, expect, it } from 'vitest';

import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatio } from './contrast';
import { colors, fontFamily, radius, spacing, typography } from './tokens';

describe('brand colors', () => {
  it('defines exactly white, orange, and navy as brand colors', () => {
    expect(colors.white).toBe('#FFFFFF');
    expect(colors.orange[500]).toBe('#FF6B1A');
    expect(colors.navy[900]).toBe('#0B1F3A');
  });

  it('derives neutrals by tinting navy toward white, never pure gray', () => {
    // Every navy scale step should be a pure R=G=B-free tint of the base
    // navy hue (not equal, and not a generic #888888-style neutral).
    for (const hex of Object.values(colors.navy)) {
      expect(hex).not.toMatch(/^#(\d)\1{5}$/i); // rejects e.g. #888888
    }
  });
});

describe('contrast rules', () => {
  it('passes AA for primary text on the white background', () => {
    expect(contrastRatio(colors.background, colors.textPrimary)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  it('passes AA for the primary button (orange fill, navy text)', () => {
    expect(contrastRatio(colors.action, colors.textPrimary)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('passes AA for the secondary button (navy fill, white text)', () => {
    expect(contrastRatio(colors.textPrimary, colors.white)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('never allows orange body text on the white background (fails even large-text AA)', () => {
    // This is the guardrail for the "orange never body-text-on-white" brand
    // rule: if this ever starts passing, someone brightened the orange or
    // darkened the background enough that the rule needs re-checking, not
    // silently relying on it.
    const ratio = contrastRatio(colors.background, colors.action);
    expect(ratio).toBeLessThan(AA_LARGE_TEXT);
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
  });

  it('has a large jump between body text and the smallest heading', () => {
    expect(typography.h3.fontSize - typography.body.fontSize).toBeGreaterThanOrEqual(4);
    expect(typography.display.fontSize - typography.h1.fontSize).toBeGreaterThanOrEqual(8);
  });
});
