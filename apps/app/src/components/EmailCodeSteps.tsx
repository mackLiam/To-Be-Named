import { View } from 'react-native';

import { CODE_LIFETIME_MINUTES } from '../hooks/useEmailCodeFlow';
import { FAKE_EXISTING_EMAIL, IS_FAKE_AUTH } from '../lib/auth';
import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';
import { Button } from './Button';
import { Heading } from './Heading';
import { TextField } from './TextField';

export function FakeModeCaption() {
  if (!IS_FAKE_AUTH) {
    return null;
  }
  return (
    <Body variant="caption" color={colors.textTertiary}>
      Test mode, no backend connected. Any 6-digit code works. {FAKE_EXISTING_EMAIL} acts as an
      existing account.
    </Body>
  );
}

/** The code step, shared with the guest upgrade on the Profile tab. */
export function CodeStep(props: {
  email: string;
  code: string;
  onChangeCode: (code: string) => void;
  busy: boolean;
  error?: string;
  resent: boolean;
  /** Seconds until a new code may be sent; 0 when it may. */
  resendWait: number;
  /** The email already has an account: this code signs in and moves the guest's scans. */
  merge?: boolean;
  onVerify: () => void;
  onResend: () => void;
  onChangeEmail: () => void;
  verifyLabel: string;
  verifyBusyLabel: string;
  /** Show the "Check your email" heading (sign-in only). */
  heading?: boolean;
}) {
  return (
    <View style={{ gap: spacing.md }}>
      {props.heading && <Heading level="h1">Check your email</Heading>}
      <Body color={colors.textSecondary}>
        Code sent to <Body variant="bodyStrong">{props.email}</Body>.
      </Body>
      {props.merge && (
        <Body color={colors.textPrimary}>
          Enter the code to sign in. Your scans from this phone move to that account.
        </Body>
      )}
      <TextField
        kind="code"
        label="6-digit code"
        value={props.code}
        onChangeText={props.onChangeCode}
        editable={!props.busy}
        error={props.error}
        autoFocus
        onSubmitEditing={props.onVerify}
      />
      <Button onPress={props.onVerify} disabled={props.busy || props.code.length < 6}>
        {props.busy ? props.verifyBusyLabel : props.verifyLabel}
      </Button>
      <View>
        <Button
          variant="text"
          onPress={props.onResend}
          disabled={props.busy || props.resendWait > 0}
        >
          {props.resendWait > 0 ? `Send a new code in ${props.resendWait}s` : 'Send a new code'}
        </Button>
        <Button variant="text" onPress={props.onChangeEmail} disabled={props.busy}>
          Use a different email
        </Button>
      </View>
      <Body variant="caption" color={colors.textSecondary}>
        {props.resent ? 'New code sent. ' : ''}Codes work for {CODE_LIFETIME_MINUTES} minutes.
      </Body>
      <FakeModeCaption />
    </View>
  );
}
