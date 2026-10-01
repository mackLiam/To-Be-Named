import { View } from 'react-native';

import { IS_FAKE_AUTH } from '../lib/auth';
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
        Test mode, no backend connected. Any 6-digit code works.
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
      <Body>
        We sent a 6-digit code to <Body variant="bodyStrong">{props.email}</Body>. Enter it below.
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
        <Button variant="outline" onPress={props.onResend} disabled={props.busy}>
          Send a new code
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
