import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Screen } from '../../src/components/Screen';
import { SESSION_TONE, StatusLabel } from '../../src/components/StatusLabel';
import { useScanSessions } from '../../src/hooks/useScans';
import { isCaptureSupported } from '../../src/lib/capture';
import {
  formatSessionDate,
  SCAN_STATUS_LABEL,
  SESSION_STATUS_LABEL,
  sessionStatus,
  type Scan,
  type ScanSession,
} from '../../src/lib/library';
import { colors, radius, spacing } from '../../src/theme/tokens';

export default function ScansScreen() {
  const router = useRouter();
  const { sessions, loading, error, reload } = useScanSessions();
  // hasLiDAR is unknown until the native module can query it (src/lib/capture.ts),
  // so every iPhone sees the entry point; capture-info runs the real check.
  const canCapture = isCaptureSupported(Platform.OS);

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
    <Screen title="Scans" onRefresh={reload} refreshing={loading && sessions.length > 0}>
      <View style={styles.hero}>
        <View style={styles.accent} />
        <Heading level="h1" color={colors.onDark}>
          {canCapture ? 'Scan your legs' : 'Scan on your iPhone'}
        </Heading>
        <Body color={colors.onDarkMuted}>
          {canCapture
            ? 'Both legs, about ten minutes.'
            : 'Needs an iPhone Pro with LiDAR. Scans show up here.'}
        </Body>
        {canCapture && (
          <View style={styles.heroAction}>
            <Button onPress={() => router.push('/capture-info')}>Start a scan</Button>
          </View>
        )}
      </View>

      {firstLoad && <ActivityIndicator color={colors.textPrimary} style={styles.loader} />}

      {error && (
        <Body color={colors.danger}>Could not load your scans. Pull down to try again.</Body>
      )}

      {sessions.length > 0 && (
        <Body variant="label" color={colors.textSecondary} style={styles.listLabel}>
          Your scans
        </Body>
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
      accessibilityLabel={`Scan from ${formatSessionDate(session.createdAt)}, ${SESSION_STATUS_LABEL[status]}. Left: ${legStatus(session.left)}. Right: ${legStatus(session.right)}.`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Heading level="h3">{formatSessionDate(session.createdAt)}</Heading>
        <StatusLabel label={SESSION_STATUS_LABEL[status]} tone={SESSION_TONE[status]} />
      </View>
      <Feather name="chevron-right" size={22} color={colors.textSecondary} />
    </Pressable>
  );
}

function legStatus(scan: Scan | null): string {
  return scan ? SCAN_STATUS_LABEL[scan.status] : 'Not scanned';
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.surfaceDark,
    borderRadius: radius,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  accent: { width: 40, height: 4, backgroundColor: colors.accentOnDark, marginBottom: spacing.sm },
  heroAction: { marginTop: spacing.md },
  loader: { marginTop: spacing.lg },
  listLabel: { marginBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  rowText: { flex: 1, gap: spacing.xs },
});
