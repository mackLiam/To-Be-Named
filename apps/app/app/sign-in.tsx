import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Screen } from '../src/components/Screen';
import { CodeStep, FakeModeCaption } from '../src/components/EmailCodeSteps';
import { TextField } from '../src/components/TextField';
import { TextLink } from '../src/components/TextLink';
import { Wordmark } from '../src/components/Wordmark';
import { PRIVACY_URL, TERMS_URL } from '../src/lib/links';
import { useAuthAction, useEmailCodeFlow } from '../src/hooks/useEmailCodeFlow';
import { colors, radius, spacing } from '../src/theme/tokens';

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
      {/* The brand block: the first thing a new parent sees says who and what. */}
      <View style={styles.brand}>
        <View style={styles.accent} />
        <Wordmark surface="brown" height={40} />
        <Heading level="h2" color={colors.onDark} style={styles.promise}>
          Shin guards fitted to your scan.
        </Heading>
      </View>

      {state.step === 'email' ? (
        <View style={styles.stack}>
          <Heading level="h1">Sign in</Heading>
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
          <Button
            onPress={() => submitEmail(email)}
            disabled={busy || email.trim() === ''}
            busy={state.busy}
          >
            {state.busy ? 'Sending code' : 'Continue'}
          </Button>
          <View style={styles.or}>
            <Button variant="outline" onPress={guest.run} disabled={busy} busy={guest.busy}>
              {guest.busy ? 'Starting' : 'Continue as guest'}
            </Button>
            <Body variant="bodySmall" color={colors.textSecondary}>
              Guest scans stay on this phone. To order, save them to an account with one code.
            </Body>
          </View>
          {guest.error && (
            <View accessibilityLiveRegion="polite" role="alert">
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
  brand: {
    backgroundColor: colors.surfaceDark,
    borderRadius: radius,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  accent: { width: 40, height: 4, backgroundColor: colors.accentOnDark },
  promise: { maxWidth: 280 },
  stack: { gap: spacing.md },
  or: { gap: spacing.sm, marginTop: spacing.md },
  legal: { marginTop: spacing.lg },
});
