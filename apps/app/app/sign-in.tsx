import { useState } from 'react';
import { Image, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Rule } from '../src/components/Rule';
import { Screen } from '../src/components/Screen';
import { CodeStep, FakeModeCaption } from '../src/components/EmailCodeSteps';
import { TextField } from '../src/components/TextField';
import { useAuthAction, useEmailCodeFlow } from '../src/hooks/useEmailCodeFlow';
import { colors, spacing } from '../src/theme/tokens';

import brandIcon from '../assets/brand/icon-brick-512.png';

const continueAsGuest = (backend: { continueAsGuest(): Promise<void> }) =>
  backend.continueAsGuest();

/**
 * Shown whenever there is no session (root layout guard). Success needs no
 * navigation here: the auth change flips the guard and the tabs mount.
 */
export default function SignInScreen() {
  const { state, submitEmail, submitCode, resend, reset } = useEmailCodeFlow('sign_in');
  const guest = useAuthAction(continueAsGuest);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const busy = state.busy || guest.busy;

  return (
    <Screen>
      <Image
        source={brandIcon}
        style={{ width: 48, height: 48 }}
        accessibilityIgnoresInvertColors
      />
      <View style={{ height: spacing.xl }} />

      {state.step === 'email' ? (
        <>
          <Heading level="display">Sign in.</Heading>
          <View style={{ height: spacing.md }} />
          <Body>
            Enter your email and we send you a 6-digit code. No password. New here? The same code
            sets up your account.
          </Body>
          <View style={{ height: spacing.lg }} />
          <TextField
            kind="email"
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            editable={!busy}
            error={state.error?.message}
            onSubmitEditing={() => submitEmail(email)}
          />
          <View style={{ height: spacing.lg }} />
          <Button onPress={() => submitEmail(email)} disabled={busy || email.trim() === ''}>
            {state.busy ? 'Sending code' : 'Send code'}
          </Button>
          <FakeModeCaption />

          <View style={{ height: spacing.xxl }} />
          <Rule />
          <Heading level="h3">Continue as guest</Heading>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall" color={colors.textSecondary}>
            Scan and order straight away, no email needed. Your scans and orders stay on this phone
            only: sign out or delete the app and they are gone. You can save them to an account
            later from Profile.
          </Body>
          <View style={{ height: spacing.lg }} />
          <Button variant="outline" onPress={guest.run} disabled={busy}>
            {guest.busy ? 'Starting' : 'Continue as guest'}
          </Button>
          {guest.error && (
            <View accessibilityLiveRegion="polite" style={{ marginTop: spacing.sm }}>
              <Body variant="bodySmall" color={colors.danger}>
                {guest.error.message}
              </Body>
            </View>
          )}
        </>
      ) : (
        <CodeStep
          email={state.email ?? ''}
          code={code}
          onChangeCode={setCode}
          busy={state.busy}
          error={state.error?.message}
          resent={state.resent}
          onVerify={() => submitCode(code)}
          onResend={resend}
          onChangeEmail={() => {
            setCode('');
            reset();
          }}
          verifyLabel="Verify"
          verifyBusyLabel="Checking code"
          heading
        />
      )}
    </Screen>
  );
}
