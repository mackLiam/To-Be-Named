import { View } from 'react-native';

import { BRAND_NAME } from '@forms/shared/brand';

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
    <>
      <View style={{ height: spacing.md }} />
      <Body variant="caption" color={colors.textTertiary}>
        Test mode, no backend connected. Any 6-digit code works. {FAKE_EXISTING_EMAIL} acts as an
        existing account.
      </Body>
    </>
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
  /** Show the "Check your email." display heading (sign-in only). */
  heading?: boolean;
}) {
  return (
    <>
      {props.heading && (
        <>
          <Heading level="display">Check your email.</Heading>
          <View style={{ height: spacing.md }} />
        </>
      )}
      {props.merge ? (
        <Body>
          That email already has a {BRAND_NAME} account. Enter the code we sent to{' '}
          <Body variant="bodyStrong">{props.email}</Body> to sign in, and your scans from this phone
          move to it.
        </Body>
      ) : (
        <Body>
          We sent a 6-digit code to <Body variant="bodyStrong">{props.email}</Body>. Enter it below.
        </Body>
      )}
      <View style={{ height: spacing.xs }} />
      <Body variant="bodySmall" color={colors.textSecondary}>
        The code works for {CODE_LIFETIME_MINUTES} minutes.
      </Body>
      <View style={{ height: spacing.lg }} />
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
      <View style={{ height: spacing.lg }} />
      <Button onPress={props.onVerify} disabled={props.busy || props.code.length < 6}>
        {props.busy ? props.verifyBusyLabel : props.verifyLabel}
      </Button>
      <View style={{ height: spacing.lg }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button
          variant="outline"
          onPress={props.onResend}
          disabled={props.busy || props.resendWait > 0}
        >
          {props.resendWait > 0 ? `Send a new code in ${props.resendWait}s` : 'Send a new code'}
        </Button>
        <Button variant="outline" onPress={props.onChangeEmail} disabled={props.busy}>
          Use a different email
        </Button>
      </View>
      {props.resent && (
        <>
          <View style={{ height: spacing.sm }} />
          <Body variant="caption" color={colors.textSecondary}>
            New code sent to {props.email}.
          </Body>
        </>
      )}
      <FakeModeCaption />
    </>
  );
}
