/**
 * Zells design tokens - the single source of truth for color, spacing, radius,
 * and type. Every screen imports from here; nothing in app/ or src/ references
 * a raw hex value, a raw pixel spacing number, or a font family string that
 * did not come from this file. See .claude/agents/zells-designer.md for the
 * brand rules this file encodes.
 *
 * Brand system: white, orange, navy. Nothing else as a brand color. Grays are
 * navy-tinted neutrals (mixed toward white), never pure #888-style gray.
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/**
 * Navy is the anchor: headers, primary text on white, dark sections.
 * #0B1F3A chosen deliberately - a near-black navy (not a mid-tone "SaaS
 * blue") so it reads as ink, not as an accent color competing with orange.
 */
const navy = {
  900: '#0B1F3A', // base navy - primary text on white, dark section backgrounds
  700: '#48576B', // secondary text on white, muted headings on navy
  500: '#798493', // tertiary text, icons, dividers on white
  300: '#AAB1BA', // disabled text, hairline borders on white
  100: '#DADDE1', // borders, input outlines, subtle section separators
  50: '#F0F2F3', // faint section backgrounds (never pure white-on-white seams)
} as const;

/**
 * Orange is the action color: primary buttons, key highlights, active tab
 * state. #FF6B1A chosen deliberately - a hot, saturated orange with enough
 * red in it to stay warm (not a candy/pastel orange). Used sparingly: large
 * text, buttons with white/navy text, and accents only. Never small body
 * text on white (fails contrast; see tokens.test.ts contrast check).
 */
const orange = {
  500: '#FF6B1A', // default: buttons, active states, key accents
  600: '#E85A0C', // pressed/hover state, slightly darker for feedback
} as const;

const white = '#FFFFFF';

export const colors = {
  navy,
  orange,
  white,
  // Semantic aliases - prefer these in screens over the raw scale where the
  // usage is generic, so intent stays legible in component code.
  background: white,
  surfaceMuted: navy[50],
  textPrimary: navy[900],
  textSecondary: navy[700],
  textTertiary: navy[500],
  border: navy[100],
  action: orange[500],
  actionPressed: orange[600],
  danger: '#B3261E', // used only for scan/order failure states, never decorative
} as const;

// ---------------------------------------------------------------------------
// Radius - one value, everywhere. Rectangles, not pills (banned look #3).
// ---------------------------------------------------------------------------

export const radius = 4;

// ---------------------------------------------------------------------------
// Spacing - an intentionally uneven scale (not a flat 4px-linear ramp) so
// layouts can use generous, asymmetric whitespace instead of a uniform
// p-4/p-6 rhythm on everything.
// ---------------------------------------------------------------------------

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 28,
  xl: 48,
  xxl: 72,
  xxxl: 112,
} as const;

// ---------------------------------------------------------------------------
// Typography - Outfit for headings/display, Manrope for body/UI. Big jumps
// between levels; never compress everything into 16-24px.
// ---------------------------------------------------------------------------

export const fontFamily = {
  display: 'Outfit_800ExtraBold',
  headingBold: 'Outfit_700Bold',
  headingSemiBold: 'Outfit_600SemiBold',
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodyBold: 'Manrope_700Bold',
} as const;

export const typography = {
  display: { fontFamily: fontFamily.display, fontSize: 56, lineHeight: 60, letterSpacing: -0.5 },
  h1: { fontFamily: fontFamily.headingBold, fontSize: 40, lineHeight: 44, letterSpacing: -0.25 },
  h2: { fontFamily: fontFamily.headingSemiBold, fontSize: 28, lineHeight: 32, letterSpacing: 0 },
  h3: { fontFamily: fontFamily.headingSemiBold, fontSize: 20, lineHeight: 26, letterSpacing: 0 },
  body: { fontFamily: fontFamily.body, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  bodyStrong: { fontFamily: fontFamily.bodyMedium, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  bodySmall: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  label: {
    fontFamily: fontFamily.bodyBold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: 0.6,
  },
  caption: { fontFamily: fontFamily.bodyMedium, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
} as const;

// Fonts to load with expo-font in the root layout. Keys match fontFamily
// values above so useFonts(fontsToLoad) and the tokens stay in sync.
export const fontsToLoad = {
  Outfit_800ExtraBold: 'Outfit_800ExtraBold',
  Outfit_700Bold: 'Outfit_700Bold',
  Outfit_600SemiBold: 'Outfit_600SemiBold',
  Manrope_400Regular: 'Manrope_400Regular',
  Manrope_500Medium: 'Manrope_500Medium',
  Manrope_700Bold: 'Manrope_700Bold',
} as const;

export const theme = { colors, radius, spacing, fontFamily, typography } as const;

export type Theme = typeof theme;
