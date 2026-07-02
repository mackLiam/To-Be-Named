import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { spacing, colors } from '../../src/theme/tokens';

/**
 * No auth flow yet (deferred per CLAUDE.md, Phase 0 focus is the pipeline).
 * Structured so Supabase Auth (Sign in with Apple + email OTP, see
 * docs/DESIGN.md section 4) drops in without reshaping this screen: the
 * "signed out" block below becomes conditional on session state.
 */
export default function ProfileScreen() {
  return (
    <Screen>
      <Heading level="display">Your account.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        Sign-in is not live yet. When it is, your scans, orders, and shipping details live here,
        tied to one account across phone and web.
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button variant="outline" disabled>
        Sign in (coming soon)
      </Button>
      <Rule />

      <Heading level="h3">Your data</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary} variant="bodySmall">
        A leg scan is personal data. The raw scan is deleted after your order ships; the
        measurements used to build your guard are kept so a reorder never needs a rescan. Full
        details land here alongside sign-in.
      </Body>

      <Rule />

      <Heading level="h3">Support</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary} variant="bodySmall">
        Scan trouble, order questions, fit issues: support contact details land here once the
        account layer ships.
      </Body>
    </Screen>
  );
}
