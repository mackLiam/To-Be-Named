import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { Measurements } from '@forms/shared';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useScanSession } from '../../src/hooks/useScans';
import {
  formatMm,
  formatSessionDate,
  LEG_LABEL,
  SCAN_STATUS_LABEL,
  SESSION_STATUS_LABEL,
  SLICE_DIMS,
  SLICES,
  sessionStatus,
  sliceKey,
  type Scan,
} from '../../src/lib/library';
import type { Leg } from '../../src/lib/upload';
import { colors, spacing } from '../../src/theme/tokens';

/** Slice heights, from the frozen contract (root CLAUDE.md gotcha 2). */
const SLICE_HEIGHT: Record<(typeof SLICES)[number], string> = {
  S1: '20%',
  S2: '40%',
  S3: '60%',
  S4: '80%',
};

export default function ScanDetailScreen() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const { session, measurements, loading, error, reload } = useScanSession(key ?? '');

  if (!session) {
    return (
      <Screen onRefresh={reload} refreshing={false}>
        {loading ? (
          <Body color={colors.textSecondary}>Loading this scan.</Body>
        ) : error ? (
          <Body color={colors.danger}>Could not load this scan. Pull down to try again.</Body>
        ) : (
          <>
            <Heading level="h2">Scan not found.</Heading>
            <View style={{ height: spacing.sm }} />
            <Body color={colors.textSecondary}>It may have been removed from your library.</Body>
          </>
        )}
      </Screen>
    );
  }

  const status = sessionStatus(session);

  return (
    <Screen onRefresh={reload} refreshing={loading}>
      <Body
        variant="label"
        color={status === 'needs_rescan' ? colors.danger : colors.textSecondary}
      >
        {SESSION_STATUS_LABEL[status]}
      </Body>
      <View style={{ height: spacing.sm }} />
      <Heading level="h1">{formatSessionDate(session.createdAt)}</Heading>
      <View style={{ height: spacing.lg }} />

      {status === 'ready' && (
        <Button onPress={() => router.navigate('/shop')}>Order guards from this scan</Button>
      )}
      {status === 'one_leg' && (
        <Button onPress={() => router.navigate('/shop')}>Order a single guard</Button>
      )}
      {status === 'needs_rescan' && (
        <Button onPress={() => router.navigate('/')}>Scan again</Button>
      )}
      {status === 'processing' && (
        <Body color={colors.textSecondary}>
          Measuring takes a few minutes per leg. Pull down to check again.
        </Body>
      )}

      {error && (
        <>
          <View style={{ height: spacing.md }} />
          <Body color={colors.danger}>Could not load measurements. Pull down to try again.</Body>
        </>
      )}

      <Rule />
      <LegSection
        leg="L"
        scan={session.left}
        values={session.left && measurements.get(session.left.id)}
      />
      <LegSection
        leg="R"
        scan={session.right}
        values={session.right && measurements.get(session.right.id)}
      />
    </Screen>
  );
}

function LegSection({
  leg,
  scan,
  values,
}: {
  leg: Leg;
  scan: Scan | null;
  values: Measurements | null | undefined;
}) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={styles.legHeader}>
        <Heading level="h2">{LEG_LABEL[leg]}</Heading>
        <Body
          variant="bodySmall"
          color={scan?.status === 'failed' ? colors.danger : colors.textSecondary}
        >
          {scan ? SCAN_STATUS_LABEL[scan.status] : 'Not scanned'}
        </Body>
      </View>
      <View style={{ height: spacing.sm }} />
      <LegBody scan={scan} values={values} />
      <Rule />
    </View>
  );
}

function LegBody({ scan, values }: { scan: Scan | null; values: Measurements | null | undefined }) {
  if (!scan) {
    return (
      <Body color={colors.textSecondary} variant="bodySmall">
        This leg was not scanned in this session.
      </Body>
    );
  }
  if (scan.status === 'failed') {
    return (
      <Body color={colors.textSecondary} variant="bodySmall">
        The measurements did not pass our checks, so nothing was sent to print. Scan this leg again
        in good light, walking a full circle around it.
      </Body>
    );
  }
  if (!values) {
    return (
      <Body color={colors.textSecondary} variant="bodySmall">
        Measurements appear here once this leg is measured.
      </Body>
    );
  }
  return (
    <View>
      <View style={styles.legLength}>
        <Body color={colors.textSecondary}>Leg length, ankle to knee</Body>
        <Body variant="bodyStrong">{formatMm(values.Leg_Length)}</Body>
      </View>
      <View style={{ height: spacing.md }} />
      <Body variant="caption" color={colors.textTertiary}>
        Slices, millimetres, measured up from the ankle
      </Body>
      <View style={{ height: spacing.xs }} />
      <View style={styles.tableRow}>
        <Body variant="caption" color={colors.textTertiary} style={styles.sliceCell}>
          {' '}
        </Body>
        {SLICE_DIMS.map((dim) => (
          <Body key={dim} variant="caption" color={colors.textTertiary} style={styles.cell}>
            {dim}
          </Body>
        ))}
      </View>
      {SLICES.map((slice) => (
        <View key={slice} style={styles.tableRow}>
          <Body variant="caption" color={colors.textSecondary} style={styles.sliceCell}>
            {SLICE_HEIGHT[slice]}
          </Body>
          {SLICE_DIMS.map((dim) => (
            <Body key={dim} variant="bodySmall" style={styles.cell}>
              {values[sliceKey(slice, dim)].toFixed(1)}
            </Body>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  legHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  legLength: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sliceCell: {
    width: 36,
  },
  cell: {
    flex: 1,
    textAlign: 'right',
  },
});
