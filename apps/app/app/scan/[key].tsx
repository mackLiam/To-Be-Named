import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { Measurements } from '@forms/shared';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { FitPreview } from '../../src/components/FitPreview';
import { Heading } from '../../src/components/Heading';
import { ListGroup, ListRow } from '../../src/components/List';
import { Screen } from '../../src/components/Screen';
import { SESSION_TONE, StatusLabel } from '../../src/components/StatusLabel';
import { useDeleteScanSession, useScanSession } from '../../src/hooks/useScans';
import {
  failedStepGuidance,
  formatMm,
  formatSessionDate,
  LEG_LABEL,
  orderableLegs,
  SCAN_STATUS_LABEL,
  SESSION_STATUS_LABEL,
  SLICE_DIMS,
  SLICES,
  sessionLegs,
  sessionStatus,
  sliceKey,
  type Scan,
  type ScanSession,
} from '../../src/lib/library';
import type { Leg } from '../../src/lib/upload';
import { colors, spacing, typography } from '../../src/theme/tokens';

/** Slice heights, from the frozen contract (root CLAUDE.md gotcha 2). */
const SLICE_HEIGHT: Record<(typeof SLICES)[number], string> = {
  S1: '20%',
  S2: '40%',
  S3: '60%',
  S4: '80%',
};

export default function ScanDetailScreen() {
  const router = useRouter();
  // fresh=1: the capture flow just saved this scan and sent the user here to
  // keep it, rescan, or delete it.
  const { key, fresh } = useLocalSearchParams<{ key: string; fresh?: string }>();
  const { session, measurements, loading, error, reload } = useScanSession(key ?? '');
  const { remove, deleting, error: deleteError } = useDeleteScanSession(session);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showMeasurements, setShowMeasurements] = useState(false);

  async function deleteThen(rescan: boolean) {
    if (await remove()) {
      router.navigate('/');
      if (rescan) {
        router.push('/capture-info');
      }
    }
  }

  if (!session) {
    return (
      <Screen onRefresh={reload} refreshing={false}>
        {loading ? (
          <ActivityIndicator color={colors.textPrimary} />
        ) : error ? (
          <Body color={colors.danger}>Could not load this scan. Pull down to try again.</Body>
        ) : (
          <Heading level="h2">Scan not found</Heading>
        )}
      </Screen>
    );
  }

  const status = sessionStatus(session);
  const orderable = orderableLegs(session, measurements);
  const leftValues = session.left ? measurements.get(session.left.id) : undefined;
  const rightValues = session.right ? measurements.get(session.right.id) : undefined;
  const measured = [
    { leg: 'L' as const, values: leftValues },
    { leg: 'R' as const, values: rightValues },
  ].filter((m): m is { leg: Leg; values: Measurements } => Boolean(m.values));

  return (
    <Screen onRefresh={reload} refreshing={loading}>
      <StatusLabel label={SESSION_STATUS_LABEL[status]} tone={SESSION_TONE[status]} />
      <View style={{ height: spacing.sm }} />
      <Heading level="h1">{formatSessionDate(session.createdAt)}</Heading>
      <View style={{ height: spacing.lg }} />

      <FitPreview left={leftValues} right={rightValues} />
      <View style={{ height: spacing.lg }} />

      <View style={styles.actions}>
        {status === 'needs_rescan' && (
          <Button onPress={() => router.push('/capture-info')}>{rescanLabel(session)}</Button>
        )}
        {orderable.length > 0 && (
          <Button
            variant={status === 'needs_rescan' ? 'outline' : 'primary'}
            onPress={() => router.navigate(`/order/${session.key}`)}
          >
            Order a guard
          </Button>
        )}
        {fresh === '1' && orderable.length === 0 && status !== 'needs_rescan' && (
          <Button onPress={() => router.navigate('/')}>Done</Button>
        )}
        {status === 'one_leg' && (
          <Button variant="text" onPress={() => router.push('/capture-info')}>
            Scan the other leg
          </Button>
        )}
      </View>
      {status === 'processing' && (
        <Body color={colors.textSecondary} style={styles.note}>
          Measuring takes a few minutes. Pull down to refresh.
        </Body>
      )}
      {error && (
        <Body color={colors.danger} style={styles.note}>
          Could not load measurements. Pull down to try again.
        </Body>
      )}
      <View style={{ height: spacing.xl }} />

      <ListGroup>
        <LegRow leg="L" scan={session.left} pairId={pairIdOf(session)} />
        <LegRow leg="R" scan={session.right} pairId={pairIdOf(session)} />
        {measured.length > 0 && (
          <ListRow
            label="Measurements"
            onPress={() => setShowMeasurements((v) => !v)}
            icon={showMeasurements ? 'chevron-up' : 'chevron-down'}
            accessibilityState={{ expanded: showMeasurements }}
          >
            {showMeasurements &&
              measured.map((m) => <LegTable key={m.leg} leg={m.leg} values={m.values} />)}
          </ListRow>
        )}
      </ListGroup>

      <ListGroup>
        <ListRow
          label="Delete scan"
          tone="danger"
          icon={null}
          onPress={() => setConfirmingDelete(true)}
          disabled={confirmingDelete}
          accessibilityState={{ expanded: confirmingDelete }}
        >
          {confirmingDelete && (
            <View accessibilityLiveRegion="polite" style={styles.actions}>
              <Body variant="bodySmall">Both legs are erased. This cannot be undone.</Body>
              <Button variant="danger" disabled={deleting} onPress={() => deleteThen(true)}>
                Delete and rescan
              </Button>
              <Button variant="outline" disabled={deleting} onPress={() => deleteThen(false)}>
                Delete only
              </Button>
              <Button variant="text" disabled={deleting} onPress={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </View>
          )}
          {deleteError && <Body color={colors.danger}>{deleteError}</Body>}
        </ListRow>
      </ListGroup>
    </Screen>
  );
}

/** The pair both legs share, or '' for a lone unpaired leg. */
function pairIdOf(session: ScanSession): string {
  return session.left?.pairId ?? session.right?.pairId ?? '';
}

/** Tapping a leg opens the hand-measurement screen: enter values for a
 * failed or missing leg, or check and adjust a measured one. */
function LegRow({ leg, scan, pairId }: { leg: Leg; scan: Scan | null; pairId: string }) {
  const router = useRouter();
  const failed = scan !== null && scan.status === 'failed';
  const action = !scan
    ? { mode: 'manual', scanId: 'new', hint: 'Enter this leg by hand' }
    : failed
      ? { mode: 'manual', scanId: scan.id, hint: 'Enter this leg by hand' }
      : scan.status === 'ready'
        ? { mode: 'adjust', scanId: scan.id, hint: 'Check or adjust the measurements' }
        : null;
  return (
    <ListRow
      label={LEG_LABEL[leg]}
      value={scan ? SCAN_STATUS_LABEL[scan.status] : 'Not scanned'}
      detail={
        failed
          ? `${failedStepGuidance(scan.failedStep)} Or tap to enter it by hand.`
          : action && !scan
            ? 'Tap to enter it by hand.'
            : undefined
      }
      tone={failed ? 'danger' : 'default'}
      accessibilityHint={action?.hint}
      onPress={
        action
          ? () =>
              router.navigate({
                pathname: '/measure/[scanId]',
                params: {
                  scanId: action.scanId,
                  mode: action.mode,
                  pairId,
                  ...(scan ? {} : { leg }),
                },
              })
          : undefined
      }
    />
  );
}

function LegTable({ leg, values }: { leg: Leg; values: Measurements }) {
  return (
    <View style={styles.table}>
      <View style={styles.legLength}>
        <Body variant="bodyStrong">{LEG_LABEL[leg]}</Body>
        <Body variant="bodyStrong">{formatMm(values.Leg_Length)}</Body>
      </View>
      <Body variant="caption" color={colors.textSecondary}>
        Millimetres, measured up from the ankle
      </Body>
      <View
        style={styles.tableRow}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.dimCell} />
        {SLICES.map((slice) => (
          <Body key={slice} variant="caption" color={colors.textSecondary} style={styles.cell}>
            {SLICE_HEIGHT[slice]}
          </Body>
        ))}
      </View>
      {SLICE_DIMS.map((dim) => (
        <View
          key={dim}
          style={styles.tableRow}
          accessible
          accessibilityLabel={`${dim}: ${SLICES.map((slice) => values[sliceKey(slice, dim)].toFixed(1)).join(', ')} millimetres, ankle to knee`}
        >
          <Body variant="caption" color={colors.textSecondary} style={styles.dimCell}>
            {dim}
          </Body>
          {SLICES.map((slice) => (
            <Text
              key={slice}
              numberOfLines={1}
              style={[typography.bodySmall, styles.cell, styles.value]}
            >
              {values[sliceKey(slice, dim)].toFixed(1)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function rescanLabel(session: ScanSession): string {
  const failed = sessionLegs(session).filter((scan) => scan.status === 'failed');
  return failed.length === 1 && failed[0]
    ? `Rescan ${LEG_LABEL[failed[0].leg].toLowerCase()}`
    : 'Scan both legs again';
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.sm,
  },
  note: {
    marginTop: spacing.md,
  },
  table: {
    marginTop: spacing.md,
    gap: spacing.xs,
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
  dimCell: {
    width: spacing.xl,
  },
  cell: {
    flex: 1,
    textAlign: 'right',
  },
  value: {
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
});
