import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useScanSessions } from '../../src/hooks/useScans';
import {
  formatSessionDate,
  SCAN_STATUS_LABEL,
  SESSION_STATUS_LABEL,
  sessionStatus,
  type Scan,
  type ScanSession,
} from '../../src/lib/library';
import { colors, spacing } from '../../src/theme/tokens';

export default function ScansScreen() {
  const router = useRouter();
  const { sessions, loading, error, reload } = useScanSessions();

  // Refresh when the tab regains focus (e.g. back from a capture) but not on
  // the first focus, which the hook's own initial load already covers.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) {
        reload();
      }
      focusedOnce.current = true;
    }, [reload]),
  );

  const firstLoad = loading && sessions.length === 0;

  return (
    <Screen onRefresh={reload} refreshing={loading && sessions.length > 0}>
      <Heading level="display">Your scan library.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        Each scan is both legs, left and right, measured separately. Every one is kept here, so a
        reorder never needs a rescan.
      </Body>
      <Rule />

      {firstLoad && <Body color={colors.textSecondary}>Loading your scans.</Body>}

      {error && (
        <Body color={colors.danger}>
          Could not load your scans right now. Pull down to try again.
        </Body>
      )}

      {!loading && !error && sessions.length === 0 && (
        <View>
          <Heading level="h3">No scans yet.</Heading>
          <View style={{ height: spacing.sm }} />
          <Body color={colors.textSecondary}>
            Start one from the Scan tab. It takes about ten minutes for both legs.
          </Body>
          <View style={{ height: spacing.lg }} />
          <Button onPress={() => router.navigate('/')}>Start a scan</Button>
        </View>
      )}

      {sessions.map((session) => (
        <SessionRow
          key={session.key}
          session={session}
          onPress={() => router.push({ pathname: '/scan/[key]', params: { key: session.key } })}
        />
      ))}
    </Screen>
  );
}

function SessionRow({ session, onPress }: { session: ScanSession; onPress: () => void }) {
  const status = sessionStatus(session);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Scan from ${formatSessionDate(session.createdAt)}, ${SESSION_STATUS_LABEL[status]}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowHeader}>
        <Heading level="h3">{formatSessionDate(session.createdAt)}</Heading>
        <Feather name="chevron-right" size={20} color={colors.textSecondary} />
      </View>
      <Body
        variant="label"
        color={status === 'needs_rescan' ? colors.danger : colors.textSecondary}
      >
        {SESSION_STATUS_LABEL[status]}
      </Body>
      <View style={{ height: spacing.sm }} />
      <View style={styles.legs}>
        <LegCell label="Left" scan={session.left} />
        <LegCell label="Right" scan={session.right} />
      </View>
      <Rule />
    </Pressable>
  );
}

function LegCell({ label, scan }: { label: string; scan: Scan | null }) {
  const failed = scan?.status === 'failed';
  return (
    <View style={styles.leg}>
      <Body variant="caption" color={colors.textTertiary}>
        {label}
      </Body>
      <Body variant="bodySmall" color={failed ? colors.danger : colors.textPrimary}>
        {scan ? SCAN_STATUS_LABEL[scan.status] : 'Not scanned'}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingTop: spacing.sm,
  },
  rowPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  legs: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  leg: {
    flex: 1,
  },
});
