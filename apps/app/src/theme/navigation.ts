import { colors, fontFamily, spacing, typography } from './tokens';

/**
 * Native stack header style for every screen that shows one. Without an
 * explicit title font the header falls back to the platform system font,
 * the one place Outfit/Manrope would otherwise leak out of the app.
 */
export const stackHeader = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.textPrimary,
  headerShadowVisible: false,
  headerTitleStyle: { fontFamily: fontFamily.headingSemiBold, fontSize: typography.h3.fontSize },
  headerBackTitleStyle: { fontFamily: fontFamily.bodyMedium },
} as const;

/** Tab bar: stud brown block, yellow active, muted inactive (5.7:1 on brown).
 * The item box (height minus padding) must hold a 24 pt icon plus a 16 pt
 * label line; 48 squeezed the label to 10 pt and clipped it on web. */
export const TAB_BAR_CONTENT_HEIGHT = 64;
const TAB_BAR_PAD = spacing.xs;

export function tabBarStyle(bottomInset: number) {
  return {
    backgroundColor: colors.surfaceDark,
    borderTopWidth: 0,
    height: TAB_BAR_CONTENT_HEIGHT + bottomInset,
    paddingTop: TAB_BAR_PAD,
    paddingBottom: Math.max(bottomInset, TAB_BAR_PAD),
  } as const;
}

export const tabBarLabelStyle = {
  fontFamily: typography.label.fontFamily,
  fontSize: typography.caption.fontSize,
  lineHeight: typography.caption.lineHeight,
} as const;
