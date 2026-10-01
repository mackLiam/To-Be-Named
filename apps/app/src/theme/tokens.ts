/**
 * FORMS design tokens - the single source of truth for color, spacing, radius,
 * and type. Every screen imports from here; nothing in app/ or src/ references
 * a raw hex value, a raw pixel spacing number, or a font family string that
 * did not come from this file. See .claude/agents/forms-designer.md for the
 * brand rules this file encodes.
 *
 * Brand system (designer's colors.txt, "5a Faded Card"): card yellow, brick
 * red, stud brown, bright brick. Nothing else as a brand color; no white.
 * Neutrals are stud brown tinted toward card yellow, never pure gray.
 * Every text/background pair used below is asserted in tokens.test.ts.
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Card yellow: the field. Main background everywhere light. */
const yellow = '#EDD27A';

/**
 * Stud brown is the anchor: primary text on yellow, dark sections. The scale
 * is a linear mix of 900 toward card yellow at uneven stops: yellow is
 * mid-luminance, so only the first ~20% of the ramp still passes AA as text. 700 and 500 sit inside that band (text); 300 and
 * below are non-text only (borders, rules, disabled, surfaces).
 */
const brown = {
  900: '#3A2E26', // base, 0% - primary text on yellow, dark section backgrounds
  700: '#4C3E2E', // 10% - secondary text (6.9:1 on yellow), pressed dark fill
  500: '#5E4F37', // 20% - tertiary text (5.3:1 on yellow, 4.8:1 on brown 50)
  300: '#948050', // 50% - disabled text, strong hairlines; never body text
  100: '#C0A965', // 75% - borders on yellow; muted text on brown 900 (5.7:1)
  50: '#E2C875', // 94% - muted section surface on the yellow field
} as const;

/**
 * Brick red. 500 is the pinned brand hex: wordmark letters, large display
 * accents, graphic fills with no small text. It is 4.1:1 against yellow, so it
 * fails AA for normal text in either direction (brick text on yellow, yellow
 * text on brick). 600 is brick mixed 15% toward stud brown, the smallest step
 * that clears 4.5:1 with yellow: it is the action fill (buttons, banners,
 * badges) and the color of small action text. 700 (30%) is the pressed state.
 */
const brick = {
  500: '#B0362C',
  600: '#9E352B',
  700: '#8D342A',
} as const;

/**
 * Bright brick: accent on stud brown ONLY (3.4:1 there, large text and
 * graphics only; 2.6:1 on yellow, so never on the light field at any size).
 */
const brightBrick = '#E0513F';

export const colors = {
  yellow,
  brown,
  brick,
  brightBrick,
  // Semantic aliases - prefer these in screens over the raw scale where the
  // usage is generic, so intent stays legible in component code.
  background: yellow,
  surfaceMuted: brown[50],
  textPrimary: brown[900],
  textSecondary: brown[700],
  textTertiary: brown[500],
  border: brown[100],
  disabled: brown[300],
  action: brick[600],
  actionPressed: brick[700],
  onAction: yellow,
  surfaceDark: brown[900],
  onDark: yellow,
  onDarkMuted: brown[100],
  accentOnDark: brightBrick,
  /**
   * Scan/order failure states only, never decorative. A red here would read
   * as the brand (brick), so failure is a dark cool oxblood: 1.6:1 darker than
   * brick 500 and shifted toward crimson, 6.8:1 on yellow. Failure copy must
   * also say it failed in words; color is never the only signal.
   */
  danger: '#7D1D2C',
} as const;

// ---------------------------------------------------------------------------
// Radius - one value, everywhere. Rectangles, not pills (banned look #3).
// ---------------------------------------------------------------------------

export const radius = 8;

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
  /** Button and tappable-row labels: sentence case, never uppercase. */
  button: { fontFamily: fontFamily.bodyBold, fontSize: 17, lineHeight: 22, letterSpacing: 0 },
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
