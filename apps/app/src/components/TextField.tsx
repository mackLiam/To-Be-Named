import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, fontFamily, radius, spacing, typography } from '../theme/tokens';
import { Body } from './Body';

type Kind = 'email' | 'code';

interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  kind: Kind;
  error?: string | null;
  editable?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}

/** Platform props per kind, so autofill (email, one-time code from Mail/SMS)
 * works without every caller remembering them. */
const KIND_PROPS: Record<Kind, TextInputProps> = {
  email: {
    keyboardType: 'email-address',
    inputMode: 'email',
    autoComplete: 'email',
    textContentType: 'emailAddress',
    autoCapitalize: 'none',
    autoCorrect: false,
    spellCheck: false,
    returnKeyType: 'send',
  },
  code: {
    keyboardType: 'number-pad',
    inputMode: 'numeric',
    autoComplete: 'one-time-code',
    textContentType: 'oneTimeCode',
    // Supabase codes are 6 by default and configurable up to 10 (auth.ts).
    maxLength: 10,
    returnKeyType: 'done',
  },
};

/**
 * Labelled input. Border width never changes between rest, focus and error,
 * so the layout never shifts; the border color carries the state and the
 * error text says what failed, so color is never the only signal.
 */
export function TextField({
  label,
  value,
  onChangeText,
  kind,
  error,
  editable = true,
  placeholder,
  autoFocus,
  onSubmitEditing,
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Body variant="label">{label}</Body>
      <View style={{ height: spacing.sm }} />
      <TextInput
        {...KIND_PROPS[kind]}
        accessibilityLabel={label}
        aria-invalid={Boolean(error)}
        value={value}
        onChangeText={
          kind === 'code' ? (text) => onChangeText(text.replace(/\D/g, '')) : onChangeText
        }
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        selectionColor={colors.action}
        cursorColor={colors.textPrimary}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.field,
          kind === 'code' ? styles.codeText : styles.emailText,
          focused && styles.focused,
          error ? styles.error : null,
        ]}
      />
      {error ? (
        <View accessibilityLiveRegion="polite" role="alert" style={{ marginTop: spacing.sm }}>
          <Body variant="bodySmall" color={colors.danger}>
            {error}
          </Body>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  field: {
    minHeight: 56,
    borderWidth: 2,
    borderRadius: radius,
    borderColor: colors.textSecondary,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    // The focus border below replaces the browser outline.
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null),
  },
  emailText: typography.bodyStrong,
  codeText: {
    ...typography.h2,
    fontFamily: fontFamily.headingBold,
    letterSpacing: spacing.sm,
    fontVariant: ['tabular-nums'],
  },
  focused: { borderColor: colors.textPrimary, backgroundColor: colors.surfaceMuted },
  error: { borderColor: colors.danger },
});
