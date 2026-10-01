import { useState } from 'react';
import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { CodeStep, FakeModeCaption } from '../../src/components/EmailCodeSteps';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { TextLink } from '../../src/components/TextLink';
import { TextField } from '../../src/components/TextField';
import { useAccount } from '../../src/hooks/useAccount';
import { useAuthAction, useEmailCodeFlow } from '../../src/hooks/useEmailCodeFlow';
import type { AuthBackend } from '../../src/lib/auth';
import { dataExportFile } from '../../src/lib/dataExport';
import { shareFile } from '../../src/lib/shareFile';
import {
  PRIVACY_URL,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
  SUPPORT_URL,
  TERMS_URL,
} from '../../src/lib/links';
import { colors, spacing } from '../../src/theme/tokens';

const signOut = (backend: AuthBackend) => backend.signOut('local');
const signOutEverywhere = (backend: AuthBackend) => backend.signOut('global');
const deleteAccount = (backend: AuthBackend) => backend.deleteAccount();
const exportData = async (backend: AuthBackend) =>
  shareFile(dataExportFile(await backend.exportMyData(), new Date()));

export default function ProfileScreen() {
  const { account, justSaved } = useAccount();

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
        A leg scan is personal data. The raw scan file is deleted 30 days after it is measured,
        whether or not you order. Delete a scan, or your account, and it is erased right away. The
        measurements are kept until you delete your account, so a reorder never needs a rescan.
      </Body>
      <View style={{ height: spacing.md }} />
      <DataExport />

      <Rule />
      <Heading level="h3">Support</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary} variant="bodySmall">
        Scan trouble, order questions, fit issues: email{' '}
        <TextLink href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</TextLink> or visit{' '}
        <TextLink href={SUPPORT_URL}>FORMS support</TextLink>. Read our{' '}
        <TextLink href={PRIVACY_URL}>privacy policy</TextLink> and{' '}
        <TextLink href={TERMS_URL}>terms</TextLink>.
      </Body>

      {account?.kind === 'guest' && (
        <>
          <Rule />
          <GuestSignOut />
        </>
      )}

      <Rule />
      <DeleteAccount />
    </Screen>
  );
}

function MemberSection({ email, justSaved }: { email: string | null; justSaved: boolean }) {
  const out = useAuthAction(signOut);
  const outEverywhere = useAuthAction(signOutEverywhere);
  const busy = out.busy || outEverywhere.busy;
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
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button variant="outline" onPress={out.run} disabled={busy}>
          {out.busy ? 'Signing out' : 'Sign out'}
        </Button>
        <Button variant="outline" onPress={outEverywhere.run} disabled={busy}>
          {outEverywhere.busy ? 'Signing out' : 'Sign out on all devices'}
        </Button>
      </View>
      <ActionError message={out.error?.message ?? outEverywhere.error?.message} />
    </>
  );
}

function GuestSection() {
  const { state, resendWait, submitEmail, submitCode, resend, reset } = useEmailCodeFlow('upgrade');
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
          Your scans are tied to this guest session. Sign out, delete the app, or switch phones and
          they are gone. Ordering a guard needs an account: save your scans to one below to order
          and to keep them.
        </Body>
      </View>

      <View style={{ height: spacing.xl }} />
      <Heading level="h2">Save your scans to an account.</Heading>
      <View style={{ height: spacing.sm }} />
      {state.step === 'email' ? (
        <>
          <Body>
            Enter your email and we send you a 6-digit code. Every scan from this guest session
            moves to the account. Already have an account? Use its email and the scans move there.
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
          resendWait={resendWait}
          merge={state.merge}
          onVerify={() => submitCode(code)}
          onResend={resend}
          onChangeEmail={() => {
            setCode('');
            reset();
          }}
          verifyLabel={state.merge ? 'Sign in and move scans' : 'Save to account'}
          verifyBusyLabel={state.merge ? 'Moving scans' : 'Saving'}
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
        Your guest scans cannot be recovered after you sign out, not on this phone and not by
        support. Save them to an account first if you want to keep them.
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

function DataExport() {
  const action = useAuthAction(exportData);
  return (
    <>
      <Button variant="outline" onPress={action.run} disabled={action.busy}>
        {action.busy ? 'Preparing your data' : 'Get a copy of your data'}
      </Button>
      <ActionError message={action.error?.message} />
    </>
  );
}

/** Inline two-step confirm, like GuestSignOut: Alert does nothing on web and
 * erasure cannot be undone. A refusal (order in progress) keeps the session. */
function DeleteAccount() {
  const [confirming, setConfirming] = useState(false);
  const action = useAuthAction(deleteAccount);

  return (
    <>
      <Heading level="h3">Delete account</Heading>
      <View style={{ height: spacing.sm }} />
      <Body variant="bodySmall" color={colors.textSecondary}>
        Deletes your scans, your measurements and your account. Records of past orders are kept,
        without your account attached. Deletion finishes within a few days.
      </Body>
      <View style={{ height: spacing.md }} />
      {confirming ? (
        <View
          accessibilityLiveRegion="polite"
          style={{ backgroundColor: colors.surfaceMuted, padding: spacing.lg }}
        >
          <Heading level="h3">Delete your account?</Heading>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall">
            This cannot be undone. Your scans, measurements and account are erased, and you are
            signed out on every device.
          </Body>
          <View style={{ height: spacing.lg }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            <Button variant="secondary" onPress={action.run} disabled={action.busy}>
              {action.busy ? 'Deleting' : 'Delete my account'}
            </Button>
            <Button variant="outline" onPress={() => setConfirming(false)} disabled={action.busy}>
              Keep my account
            </Button>
          </View>
          <ActionError message={action.error?.message} />
        </View>
      ) : (
        <Button variant="outline" onPress={() => setConfirming(true)}>
          Delete account
        </Button>
      )}
    </>
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
