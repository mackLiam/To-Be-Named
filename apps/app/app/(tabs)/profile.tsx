import * as Linking from 'expo-linking';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { CodeStep, FakeModeCaption } from '../../src/components/EmailCodeSteps';
import { Heading } from '../../src/components/Heading';
import { ListGroup, ListRow } from '../../src/components/List';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { useAccount } from '../../src/hooks/useAccount';
import { useAuthAction, useEmailCodeFlow } from '../../src/hooks/useEmailCodeFlow';
import type { AuthBackend } from '../../src/lib/auth';
import { dataExportFile } from '../../src/lib/dataExport';
import {
  PRIVACY_URL,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
  SUPPORT_URL,
  TERMS_URL,
} from '../../src/lib/links';
import { shareFile } from '../../src/lib/shareFile';
import { colors, radius, spacing } from '../../src/theme/tokens';

const signOut = (backend: AuthBackend) => backend.signOut('local');
const signOutEverywhere = (backend: AuthBackend) => backend.signOut('global');
const deleteAccount = (backend: AuthBackend) => backend.deleteAccount();
const exportData = async (backend: AuthBackend) =>
  shareFile(dataExportFile(await backend.exportMyData(), new Date()));

/** Same words in the "Your data" footnote and the delete confirm, so they never disagree. */
const DELETION_LINE =
  'Deleting hides your scans and signs you out everywhere at once. Erasure finishes within a few days.';

const SUPPORT_LINKS = [
  { label: 'Email support', value: SUPPORT_EMAIL, href: SUPPORT_MAILTO },
  { label: 'Help pages', href: SUPPORT_URL },
  { label: 'Privacy policy', href: PRIVACY_URL },
  { label: 'Terms', href: TERMS_URL },
];

export default function ProfileScreen() {
  const { account, justSaved } = useAccount();
  const member = account?.kind === 'member';

  return (
    <Screen title="Profile">
      {account?.kind === 'member' ? (
        <>
          <MemberHeader email={account.email} justSaved={justSaved} />
          <MemberSignOut />
        </>
      ) : (
        <>
          <GuestSave />
          <GuestSignOut />
        </>
      )}

      <DataGroup member={member} />

      <ListGroup title="Support">
        {SUPPORT_LINKS.map((link) => (
          <ListRow
            key={link.label}
            label={link.label}
            value={link.value}
            icon="external-link"
            accessibilityRole="link"
            accessibilityHint="Opens outside the app"
            onPress={() => void Linking.openURL(link.href)}
          />
        ))}
      </ListGroup>
    </Screen>
  );
}

function MemberHeader({ email, justSaved }: { email: string | null; justSaved: boolean }) {
  return (
    <View style={styles.header}>
      <Body variant="label" color={colors.textSecondary}>
        Signed in
      </Body>
      <Heading level="h2">{email}</Heading>
      {justSaved && (
        <Body variant="bodyStrong" color={colors.action}>
          Saved. Your scans are on this account now.
        </Body>
      )}
    </View>
  );
}

function GuestSave() {
  const { state, resendWait, submitEmail, submitCode, resend, reset } = useEmailCodeFlow('upgrade');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  return (
    <View style={styles.header}>
      <View style={styles.guestBlock}>
        <View style={styles.accent} />
        <Heading level="h2" color={colors.onDark}>
          Save your scans
        </Heading>
        <Body color={colors.onDarkMuted}>Guest scans live on this phone only.</Body>
      </View>
      {state.step === 'email' ? (
        <View style={styles.form}>
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
          <Button onPress={() => submitEmail(email)} disabled={state.busy || email.trim() === ''}>
            {state.busy ? 'Sending code' : 'Send code'}
          </Button>
          <FakeModeCaption />
        </View>
      ) : (
        <View style={styles.form}>
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
        </View>
      )}
    </View>
  );
}

function MemberSignOut() {
  const out = useAuthAction(signOut);
  const outEverywhere = useAuthAction(signOutEverywhere);
  const busy = out.busy || outEverywhere.busy;
  return (
    <ListGroup title="Account">
      <ListRow
        label={out.busy ? 'Signing out' : 'Sign out'}
        onPress={out.run}
        disabled={busy}
        icon={null}
      />
      <ListRow
        label={outEverywhere.busy ? 'Signing out' : 'Sign out on all devices'}
        onPress={outEverywhere.run}
        disabled={busy}
        icon={null}
      >
        <ActionError message={out.error?.message ?? outEverywhere.error?.message} />
      </ListRow>
    </ListGroup>
  );
}

/** Two steps, inline: Alert dialogs do nothing on web, and losing a guest
 * session is irreversible (its rows become unreachable), so it is never one tap. */
function GuestSignOut() {
  const [confirming, setConfirming] = useState(false);
  const out = useAuthAction(signOut);
  return (
    <ListGroup title="Account">
      <ListRow
        label="Sign out"
        onPress={() => setConfirming(true)}
        disabled={confirming}
        icon={null}
        accessibilityState={{ expanded: confirming }}
      >
        {confirming && (
          <Confirm
            line="Guest scans cannot be recovered after you sign out."
            action={out.busy ? 'Signing out' : 'Sign out and lose scans'}
            cancel="Keep my scans"
            busy={out.busy}
            onConfirm={out.run}
            onCancel={() => setConfirming(false)}
            error={out.error?.message}
          />
        )}
      </ListRow>
    </ListGroup>
  );
}

/** Inline two-step confirm, like GuestSignOut: Alert does nothing on web and
 * erasure cannot be undone. A refusal (order in progress) keeps the session.
 * Guests cannot order, so their copy never mentions orders. */
function DataGroup({ member }: { member: boolean }) {
  const exporting = useAuthAction(exportData);
  const deleting = useAuthAction(deleteAccount);
  const [confirming, setConfirming] = useState(false);
  return (
    <ListGroup
      title="Your data"
      footnote={`Raw scans are deleted 30 days after measuring.${member ? ` ${DELETION_LINE}` : ''}`}
    >
      <ListRow
        label={exporting.busy ? 'Preparing your data' : 'Get a copy of your data'}
        onPress={exporting.run}
        disabled={exporting.busy}
        icon="download"
      >
        <ActionError message={exporting.error?.message} />
      </ListRow>
      <ListRow
        label={member ? 'Delete account' : 'Delete my scans'}
        tone="danger"
        onPress={() => setConfirming(true)}
        disabled={confirming}
        icon={null}
        accessibilityState={{ expanded: confirming }}
      >
        {confirming && (
          <Confirm
            line={
              member
                ? `${DELETION_LINE} Past order records are kept without your account. This cannot be undone.`
                : "Deletes every scan in this phone's guest session. This cannot be undone."
            }
            action={deleting.busy ? 'Deleting' : member ? 'Delete my account' : 'Delete my scans'}
            cancel={member ? 'Keep my account' : 'Keep my scans'}
            busy={deleting.busy}
            onConfirm={deleting.run}
            onCancel={() => setConfirming(false)}
            error={deleting.error?.message}
          />
        )}
      </ListRow>
    </ListGroup>
  );
}

function Confirm(props: {
  line: string;
  action: string;
  cancel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  error?: string;
}) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.confirm}>
      <Body variant="bodySmall">{props.line}</Body>
      <Button variant="danger" onPress={props.onConfirm} disabled={props.busy}>
        {props.action}
      </Button>
      <Button variant="text" onPress={props.onCancel} disabled={props.busy}>
        {props.cancel}
      </Button>
      <ActionError message={props.error} />
    </View>
  );
}

function ActionError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <View accessibilityLiveRegion="polite">
      <Body variant="bodySmall" color={colors.danger}>
        {message}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginBottom: spacing.xl },
  guestBlock: {
    backgroundColor: colors.surfaceDark,
    borderRadius: radius,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  accent: { width: 40, height: 4, backgroundColor: colors.accentOnDark, marginBottom: spacing.sm },
  form: { gap: spacing.md },
  confirm: { gap: spacing.sm },
});
