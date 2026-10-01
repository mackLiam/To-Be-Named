import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Screen } from '../src/components/Screen';
import { CodeStep, FakeModeCaption } from '../src/components/EmailCodeSteps';
import { TextField } from '../src/components/TextField';
import { TextLink } from '../src/components/TextLink';
import { PRIVACY_URL, TERMS_URL } from '../src/lib/links';
import { useAuthAction, useEmailCodeFlow } from '../src/hooks/useEmailCodeFlow';
import { colors, radius, spacing } from '../src/theme/tokens';

import brandIcon from '../assets/brand/icon-brick-512.png';

const continueAsGuest = (backend: { continueAsGuest(): Promise<void> }) =>
  backend.continueAsGuest();

/**
 * Shown whenever there is no session (root layout guard). Success needs no
 * navigation here: the auth change flips the guard and the tabs mount.
 */
export default function SignInScreen() {
  const { state, resendWait, submitEmail, submitCode, resend, reset } = useEmailCodeFlow('sign_in');
  const guest = useAuthAction(continueAsGuest);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const busy = state.busy || guest.busy;

  return (
    <Screen>
      <Image source={brandIcon} style={styles.icon} accessibilityIgnoresInvertColors />

      {state.step === 'email' ? (
        <View style={styles.stack}>
          <Heading level="display">Sign in</Heading>
          <Body color={colors.textSecondary}>We email you a code. No password.</Body>
          <TextField
            kind="email"
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            editable={!busy}
            error={state.error?.message}
            autoFocus
            onSubmitEditing={() => submitEmail(email)}
          />
          <Button onPress={() => submitEmail(email)} disabled={busy || email.trim() === ''}>
            {state.busy ? 'Sending code' : 'Continue'}
          </Button>
          <Button variant="text" onPress={guest.run} disabled={busy}>
            {guest.busy ? 'Starting' : 'Continue as guest'}
          </Button>
          <Body variant="caption" color={colors.textSecondary} style={styles.center}>
            Guest scans stay on this phone. To order, save them to an account. It takes one code.
          </Body>
          {guest.error && (
            <View accessibilityLiveRegion="polite">
              <Body variant="bodySmall" color={colors.danger}>
                {guest.error.message}
              </Body>
            </View>
          )}
          <FakeModeCaption />
          <Body variant="caption" color={colors.textSecondary} style={styles.legal}>
            By continuing you agree to the <TextLink href={TERMS_URL}>Terms</TextLink> and{' '}
            <TextLink href={PRIVACY_URL}>Privacy policy</TextLink>.
          </Body>
        </View>
      ) : (
        <CodeStep
          email={state.email ?? ''}
          code={code}
          onChangeCode={setCode}
          busy={state.busy}
          error={state.error?.message}
          resent={state.resent}
          resendWait={resendWait}
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

const styles = StyleSheet.create({
  icon: {
    width: 56,
    height: 56,
    borderRadius: radius,
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  stack: { gap: spacing.md },
  center: { textAlign: 'center' },
  legal: { marginTop: spacing.xl },
});
