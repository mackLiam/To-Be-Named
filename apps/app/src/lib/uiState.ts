/**
 * Pure state selection and accessibility props for the shared UI components
 * (Button, StateView, Wordmark). Kept out of the .tsx files so Vitest can
 * cover them in the node environment (vitest.config.ts renders no components).
 */

import { colors } from '../theme/tokens';

// ---------------------------------------------------------------------------
// Async list screens
// ---------------------------------------------------------------------------

export type ListView = 'loading' | 'error' | 'empty' | 'content';

/**
 * Which one state a list screen shows. Rows win over everything: a reload
 * keeps them on screen. A retry after an error is loading again (useAsyncList
 * keeps the old error while it refetches), so loading wins over error and the
 * user sees the retry is happening instead of the same failure.
 */
export function listView({
  loading,
  error,
  count,
}: {
  loading: boolean;
  error: unknown;
  count: number;
}): ListView {
  if (count > 0) return 'content';
  if (loading) return 'loading';
  if (error) return 'error';
  return 'empty';
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonA11y {
  accessibilityRole: 'button';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState: { disabled: boolean; busy: boolean };
}

/**
 * A busy button is also disabled (a second tap must not send a second code or
 * open a second checkout) and says so to assistive tech, not only visually.
 */
export function buttonA11y({
  disabled = false,
  busy = false,
  label,
  hint,
}: {
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  hint?: string;
}): ButtonA11y {
  return {
    accessibilityRole: 'button',
    ...(label ? { accessibilityLabel: label } : {}),
    ...(hint ? { accessibilityHint: hint } : {}),
    accessibilityState: { disabled: disabled || busy, busy },
  };
}

// ---------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------

export type WordmarkSurface = 'yellow' | 'brown';

/**
 * Brand pairings (root CLAUDE.md, designer's colors.txt): on yellow, brick
 * letters with a brown O; on brown, yellow letters with a bright brick O.
 * Bright brick never appears on yellow.
 */
export function wordmarkColors(surface: WordmarkSurface): { letters: string; o: string } {
  return surface === 'brown'
    ? { letters: colors.yellow, o: colors.brightBrick }
    : { letters: colors.brick[500], o: colors.brown[900] };
}
