import { describe, expect, it } from 'vitest';

import { AA_NORMAL_TEXT, contrastRatio } from './contrast';
import { stackHeader, TAB_BAR_CONTENT_HEIGHT, tabBarLabelStyle, tabBarStyle } from './navigation';
import { colors, sizing } from './tokens';

describe('stackHeader', () => {
  it('sets brand fonts on the title and back label so no system font ships', () => {
    expect(stackHeader.headerTitleStyle.fontFamily).toContain('Outfit');
    expect(stackHeader.headerBackTitleStyle.fontFamily).toContain('Manrope');
  });

  it('sits on the yellow field with primary-text tint', () => {
    expect(stackHeader.headerStyle.backgroundColor).toBe(colors.background);
    expect(contrastRatio(stackHeader.headerTintColor, colors.background)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });
});

describe('tabBarStyle', () => {
  it('adds the bottom safe-area inset to the content height', () => {
    expect(tabBarStyle(34).height).toBe(TAB_BAR_CONTENT_HEIGHT + 34);
    expect(tabBarStyle(0).height).toBe(TAB_BAR_CONTENT_HEIGHT);
  });

  it('keeps tabs at least a full touch target tall', () => {
    expect(TAB_BAR_CONTENT_HEIGHT).toBeGreaterThanOrEqual(sizing.hitTarget);
  });

  it('leaves room for a 24 pt icon and a full label line inside the padding', () => {
    for (const inset of [0, 34]) {
      const style = tabBarStyle(inset);
      const itemBox = style.height - style.paddingTop - style.paddingBottom;
      expect(itemBox).toBeGreaterThanOrEqual(24 + tabBarLabelStyle.lineHeight + 8);
    }
  });

  it('keeps some bottom padding when there is no inset (web, Android)', () => {
    expect(tabBarStyle(0).paddingBottom).toBeGreaterThan(0);
    expect(tabBarStyle(34).paddingBottom).toBe(34);
  });

  it('uses Manrope for tab labels at caption size or larger', () => {
    expect(tabBarLabelStyle.fontFamily).toContain('Manrope');
    expect(tabBarLabelStyle.fontSize).toBeGreaterThanOrEqual(12);
  });
});

describe('tab bar colors', () => {
  it('keeps active and inactive tab labels readable on the brown bar', () => {
    expect(contrastRatio(colors.onDark, colors.surfaceDark)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(colors.onDarkMuted, colors.surfaceDark)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });
});
