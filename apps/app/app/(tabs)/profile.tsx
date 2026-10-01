import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { CodeStep, FakeModeCaption } from '../../src/components/EmailCodeSteps';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { useAccount } from '../../src/hooks/useAccount';
import { useAuthAction, useEmailCodeFlow } from '../../src/hooks/useEmailCodeFlow';
import type { AuthBackend } from '../../src/lib/auth';
import { colors, spacing } from '../../src/theme/tokens';

const signOut = (backend: AuthBackend) => backend.signOut();

export default function ProfileScreen() {
  const { account } = useAccount();
  // The upgrade keeps the user id, so this screen stays mounted through it;
  // remember the transition to confirm the save in place.
  const wasGuest = useRef(account?.kind === 'guest');
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (account?.kind === 'member' && wasGuest.current) {
      setJustSaved(true);
    }
    wasGuest.current = account?.kind === 'guest';
  }, [account?.kind]);

  return (
    <Screen>
      {account?.kind === 'member' ? (
        <MemberSection email={account.email} justSaved={justSaved} />
      ) : (
        <GuestSection />
      )}

      <Rule />
      <Heading level="h3">Your data</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary} variant="bodySmall">
        A leg scan is personal data. The raw scan is deleted after your order ships; the
        measurements used to build your guard are kept so a reorder never needs a rescan.
      </Body>

      <Rule />
      <Heading level="h3">Support</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary} variant="bodySmall">
        Scan trouble, order questions, fit issues: support contact details are coming to this
        screen.
      </Body>

      {account?.kind === 'guest' && (
        <>
          <Rule />
          <GuestSignOut />
        </>
      )}
    </Screen>
  );
}

function MemberSection({ email, justSaved }: { email: string | null; justSaved: boolean }) {
  const out = useAuthAction(signOut);
  return (
    <>
      <Heading level="display">Your account.</Heading>
      <View style={{ height: spacing.lg }} />
      <Body variant="label" color={colors.textSecondary}>
        Signed in as
      </Body>
      <View style={{ height: spacing.xs }} />
      <Heading level="h2">{email}</Heading>
      {justSaved && (
        <>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodyStrong">Saved. Your scans and orders are on this account now.</Body>
        </>
      )}
      <View style={{ height: spacing.md }} />
      <Body variant="bodySmall" color={colors.textSecondary}>
        Your scans and orders are saved to this account. Sign in with the same email on any phone or
        on the web to see them.
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button variant="outline" onPress={out.run} disabled={out.busy}>
        {out.busy ? 'Signing out' : 'Sign out'}
      </Button>
      <ActionError message={out.error?.message} />
    </>
  );
}

function GuestSection() {
  const { state, submitEmail, submitCode, resend, reset } = useEmailCodeFlow('upgrade');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  return (
    <>
      <Heading level="display">Guest mode.</Heading>
      <View style={{ height: spacing.lg }} />
      <View
        style={{
          marginHorizontal: -spacing.lg,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.xl,
          backgroundColor: colors.surfaceDark,
        }}
      >
        <View style={{ width: 48, height: 4, backgroundColor: colors.accentOnDark }} />
        <View style={{ height: spacing.md }} />
        <Heading level="h2" color={colors.onDark}>
          On this phone only.
        </Heading>
        <View style={{ height: spacing.sm }} />
        <Body color={colors.onDarkMuted}>
          Your scans and orders are tied to this guest session. Sign out, delete the app, or switch
          phones and they are gone. Save them to an account to keep them.
        </Body>
      </View>

      <View style={{ height: spacing.xl }} />
      <Heading level="h2">Save your scans to an account.</Heading>
      <View style={{ height: spacing.sm }} />
      {state.step === 'email' ? (
        <>
          <Body>
            Enter your email and we send you a 6-digit code. Every scan and order from this guest
            session moves to the account.
          </Body>
          <View style={{ height: spacing.lg }} />
          <TextField
            kind="email"
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            editable={!state.busy}
            error={state.error?.message}
            onSubmitEditing={() => submitEmail(email)}
          />
          <View style={{ height: spacing.lg }} />
          <Button onPress={() => submitEmail(email)} disabled={state.busy || email.trim() === ''}>
            {state.busy ? 'Sending code' : 'Send code'}
          </Button>
          <FakeModeCaption />
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
          verifyLabel="Save to account"
          verifyBusyLabel="Saving"
        />
      )}
    </>
  );
}

/** Two steps, inline: Alert dialogs do nothing on web, and losing a guest
 * session is irreversible (its rows become unreachable), so it is never one tap. */
function GuestSignOut() {
  const [confirming, setConfirming] = useState(false);
  const out = useAuthAction(signOut);

  if (!confirming) {
    return (
      <>
        <Heading level="h3">Sign out</Heading>
        <View style={{ height: spacing.sm }} />
        <Button variant="outline" onPress={() => setConfirming(true)}>
          Sign out of guest mode
        </Button>
      </>
    );
  }
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ backgroundColor: colors.surfaceMuted, padding: spacing.lg }}
    >
      <Heading level="h3">Sign out and lose your scans?</Heading>
      <View style={{ height: spacing.sm }} />
      <Body variant="bodySmall">
        Your guest scans and orders cannot be recovered after you sign out, not on this phone and
        not by support. Save them to an account first if you want to keep them.
      </Body>
      <View style={{ height: spacing.lg }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button variant="secondary" onPress={out.run} disabled={out.busy}>
          {out.busy ? 'Signing out' : 'Sign out and lose scans'}
        </Button>
        <Button variant="outline" onPress={() => setConfirming(false)} disabled={out.busy}>
          Keep my scans
        </Button>
      </View>
      <ActionError message={out.error?.message} />
    </View>
  );
}

function ActionError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <View accessibilityLiveRegion="polite" style={{ marginTop: spacing.sm }}>
      <Body variant="bodySmall" color={colors.danger}>
        {message}
      </Body>
    </View>
  );
}
