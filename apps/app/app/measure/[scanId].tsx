import type { MeasurementKey } from '@forms/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { MeasureDiagram } from '../../src/components/MeasureDiagram';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import {
  STEPS,
  useManualMeasurements,
  type ManualMeasurementsState,
  type MeasureMode,
} from '../../src/hooks/useManualMeasurements';
import { SLICES, formatMm } from '../../src/lib/library';
import {
  DERIVED_KEYS,
  LEG_LENGTH,
  MANUAL_KEYS,
  fieldLabel,
  formatDiff,
  formatMmShort,
  markNumber,
  parseKey,
} from '../../src/lib/manualMeasurements';
import { NEW_SCAN_ID, resultRouteKey } from '../../src/lib/manualSubmit';
import type { Leg } from '../../src/lib/upload';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

const FIELD_STEPS = MANUAL_KEYS.length;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function MeasureScreen() {
  const params = useLocalSearchParams<{
    scanId: string;
    mode?: string;
    leg?: string;
    pairId?: string;
  }>();
  const scanId = one(params.scanId) ?? NEW_SCAN_ID;
  const legParam = one(params.leg);
  const leg: Leg | null = legParam === 'L' || legParam === 'R' ? legParam : null;
  const mode: MeasureMode = one(params.mode) === 'adjust' ? 'adjust' : 'manual';
  const pairId = one(params.pairId) || null;

  const router = useRouter();
  const flow = useManualMeasurements({ scanId, mode, leg, pairId });

  if (scanId === NEW_SCAN_ID && !leg) {
    return (
      <Screen>
        <Heading level="h1">Pick a leg first.</Heading>
        <View style={{ height: spacing.md }} />
        <Body>We could not tell which leg to measure. Go back and start again.</Body>
        <View style={{ height: spacing.lg }} />
        <Button variant="outline" onPress={() => router.back()}>
          Go back
        </Button>
      </Screen>
    );
  }

  if (flow.loading) {
    return (
      <Screen>
        <Body color={colors.textSecondary}>Loading the measurements from your scan.</Body>
      </Screen>
    );
  }

  if (flow.loadError) {
    return (
      <Screen>
        <Heading level="h1">Nothing to check yet.</Heading>
        <View style={{ height: spacing.md }} />
        <Body>{flow.loadError}</Body>
        <View style={{ height: spacing.lg }} />
        <View style={styles.actions}>
          <Button onPress={() => router.setParams({ mode: 'manual' })}>Measure by hand</Button>
          <Button variant="outline" onPress={() => router.back()}>
            Go back
          </Button>
        </View>
      </Screen>
    );
  }

  const onSubmit = async () => {
    const result = await flow.submit();
    if (result) {
      router.replace({
        pathname: '/scan/[key]',
        params: { key: resultRouteKey({ pairId }, result.scanId) },
      });
    }
  };

  return (
    <Screen>
      <Eyebrow leg={leg} mode={flow.mode} />
      {flow.step === 'intro' ? (
        <Intro onStart={flow.next} onCancel={() => router.back()} />
      ) : flow.step === 'review' ? (
        <Review flow={flow} onSubmit={onSubmit} onCancel={() => router.back()} />
      ) : (
        <FieldStep flow={flow} field={flow.step} />
      )}
    </Screen>
  );
}

function Eyebrow({ leg, mode }: { leg: Leg | null; mode: MeasureMode }) {
  const legName = leg === 'L' ? 'Left leg' : leg === 'R' ? 'Right leg' : null;
  const what = mode === 'adjust' ? 'Check your scan' : 'Measure by hand';
  return (
    <>
      <Body variant="label" color={colors.textSecondary}>
        {legName ? `${legName}, ${what}` : what}
      </Body>
      <View style={{ height: spacing.lg }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------

const NEEDS = ['A soft tape measure or a ruler', 'Two hardback books', 'A pen to mark your leg'];

function Intro({ onStart, onCancel }: { onStart: () => void; onCancel: () => void }) {
  return (
    <>
      <Heading level="display">Measure by hand.</Heading>
      <View style={{ height: spacing.md }} />
      <Body style={styles.reading}>
        Nine measurements, about ten minutes. A scan is more accurate, so scan again when you can.
        This gets you a guard either way.
      </Body>

      <View style={{ height: spacing.xl }} />
      <Body variant="label">What you need</Body>
      <View style={{ height: spacing.sm }} />
      {NEEDS.map((need, i) => (
        <View key={need}>
          <Rule />
          <View style={styles.needRow}>
            <Text style={styles.needNumber}>{String(i + 1).padStart(2, '0')}</Text>
            <Body variant="bodyStrong">{need}</Body>
          </View>
        </View>
      ))}
      <Rule />

      <View style={{ height: spacing.xl }} />
      <Body variant="label">How to sit</Body>
      <View style={{ height: spacing.sm }} />
      <Body style={styles.reading}>
        Sit on a chair with your foot flat on the floor and your shin straight up and down. Bare
        leg, no sock or guard. A helper holding the books makes it easier.
      </Body>

      <View style={{ height: spacing.xl }} />
      <View style={styles.actions}>
        <Button onPress={onStart}>Start</Button>
        <Button variant="outline" onPress={onCancel}>
          Not now
        </Button>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// One measurement
// ---------------------------------------------------------------------------

function instructions(field: MeasurementKey, flow: ManualMeasurementsState): string[] {
  const parsed = parseKey(field);
  if (!parsed) {
    return [
      'Find the narrowest part of your lower leg, just above the ankle bones. Mark it with the pen. This is the ankle point.',
      'Find the soft dip just below your kneecap and mark it.',
      'Measure straight up the front of your shin between the two marks.',
    ];
  }
  const n = markNumber(parsed.slice);
  const height = flow.heights ? formatMmShort(flow.heights[parsed.slice]) : null;
  const where = height
    ? `Mark ${n} goes ${height} up from the ankle point. Mark it with the pen if you have not yet.`
    : `Mark ${n} goes ${n * 20}% of your leg length up from the ankle point.`;
  return parsed.dim === 'OW'
    ? [
        where,
        `Hold one book upright against each side of your leg at mark ${n}, both flat and parallel, just touching the skin.`,
        'Measure the gap between the two books, side to side.',
      ]
    : [
        `Stay at mark ${n}.`,
        'Hold one book flat against the front of your shin and one against the back of your calf, parallel, just touching the skin.',
        'Measure the gap between the two books, front to back.',
      ];
}

function FieldStep({ flow, field }: { flow: ManualMeasurementsState; field: MeasurementKey }) {
  const number = STEPS.indexOf(field);
  const view = parseKey(field)?.dim === 'OD' ? 'side' : 'front';
  const scanned = flow.base?.[field];
  const diff = flow.diffs.get(field);

  return (
    <>
      <View style={styles.counterRow}>
        <Text style={styles.counter}>{String(number).padStart(2, '0')}</Text>
        <Body variant="label" color={colors.textSecondary}>
          of {String(FIELD_STEPS).padStart(2, '0')}
        </Body>
      </View>
      <Progress current={number} />
      <View style={{ height: spacing.lg }} />
      <Heading level="h1">{fieldLabel(field)}</Heading>
      <View style={{ height: spacing.md }} />
      {instructions(field, flow).map((line) => (
        <Body key={line} style={styles.instruction}>
          {line}
        </Body>
      ))}

      <View style={styles.diagramBand}>
        <View style={styles.diagram}>
          <MeasureDiagram view={view} active={field} heights={flow.heights} />
        </View>
      </View>

      <MmInput
        label={`${fieldLabel(field)} in millimetres`}
        value={flow.texts[field] ?? ''}
        onChangeText={(text) => flow.setText(field, text)}
        onSubmitEditing={flow.next}
        error={flow.stepError}
        autoFocus={flow.mode === 'manual'}
      />
      {scanned !== undefined && (
        <>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall" color={colors.textSecondary}>
            Your scan: {formatMm(scanned)}
            {diff ? `. Change: ${formatDiff(diff)}` : ''}
          </Body>
          {diff?.big && <BigChange />}
        </>
      )}

      <View style={{ height: spacing.xl }} />
      <View style={styles.actions}>
        <Button onPress={flow.next}>{flow.fromReview ? 'Back to review' : 'Next'}</Button>
        {!flow.fromReview && (
          <Button variant="outline" onPress={flow.back}>
            Back
          </Button>
        )}
      </View>
    </>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel={`Measurement ${current} of ${FIELD_STEPS}`}
      accessibilityValue={{ min: 0, max: FIELD_STEPS, now: current }}
    >
      {MANUAL_KEYS.map((key, i) => (
        <View
          key={key}
          style={[
            styles.segment,
            {
              backgroundColor:
                i + 1 < current
                  ? colors.textPrimary
                  : i + 1 === current
                    ? colors.brick[500]
                    : colors.border,
            },
          ]}
        />
      ))}
    </View>
  );
}

function BigChange() {
  return (
    <View style={styles.bigChange} accessibilityLiveRegion="polite">
      <View style={styles.bigChangeBar} />
      <Body variant="bodySmall" color={colors.textPrimary}>
        <Body variant="bodySmall" color={colors.textPrimary} style={styles.strong}>
          Big change, double check.
        </Body>{' '}
        This is more than 15% away from your scan.
      </Body>
    </View>
  );
}

function MmInput({
  label,
  value,
  onChangeText,
  onSubmitEditing,
  error,
  autoFocus,
  compact,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing?: () => void;
  error?: string | null;
  autoFocus?: boolean;
  compact?: boolean;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      {!compact && <Body variant="label">{label}</Body>}
      {!compact && <View style={{ height: spacing.sm }} />}
      <View
        style={[
          styles.field,
          compact && styles.fieldCompact,
          focused && styles.fieldFocused,
          error ? styles.fieldError : null,
        ]}
      >
        <TextInput
          accessibilityLabel={label}
          aria-invalid={Boolean(error)}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          keyboardType="decimal-pad"
          inputMode="decimal"
          returnKeyType="next"
          maxLength={5}
          autoFocus={autoFocus}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          selectionColor={colors.action}
          cursorColor={colors.textPrimary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, compact && styles.inputCompact]}
        />
        <Text style={compact ? styles.unitCompact : styles.unit}>mm</Text>
      </View>
      {error ? (
        <View accessibilityLiveRegion="polite" role="alert" style={{ marginTop: spacing.sm }}>
          <Body variant="bodySmall" color={colors.danger}>
            {error}
          </Body>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function Review({
  flow,
  onSubmit,
  onCancel,
}: {
  flow: ManualMeasurementsState;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const adjust = flow.mode === 'adjust';
  const errors = flow.fieldErrors;
  const estimated = new Set(flow.estimated);

  return (
    <>
      <Heading level="display">{adjust ? 'Check your scan.' : 'Check your numbers.'}</Heading>
      <View style={{ height: spacing.md }} />
      <Body style={styles.reading}>
        {adjust
          ? 'These are the measurements from your scan. Tap one you measured differently, change it, then send it.'
          : 'Tap any measurement to do it again. When they look right, send them.'}
      </Body>

      <View style={{ height: spacing.xl }} />
      <View style={styles.reviewSplit}>
        <View style={styles.reviewList}>
          <Body variant="label">Measured</Body>
          <View style={{ height: spacing.sm }} />
          {MANUAL_KEYS.map((key) => (
            <ReviewRow
              key={key}
              field={key}
              flow={flow}
              error={errors[key]}
              onPress={() => flow.goTo(key, true)}
            />
          ))}
          <Rule />
        </View>
        <View style={styles.reviewDiagram}>
          <MeasureDiagram view="front" active={null} heights={flow.heights} />
        </View>
      </View>

      <View style={{ height: spacing.xl }} />
      <Body variant="label">{adjust ? 'From your scan' : 'Estimated from your measurements'}</Body>
      <View style={{ height: spacing.xs }} />
      <Body variant="bodySmall" color={colors.textSecondary} style={styles.reading}>
        {adjust
          ? 'The inner shape at each mark. If you change a width or depth, these follow it.'
          : 'The inner shape at each mark, worked out from your width and depth. Leave these unless you know them.'}
      </Body>
      <View style={{ height: spacing.sm }} />
      {SLICES.map((slice) => {
        const keys = DERIVED_KEYS.filter((key) => parseKey(key)?.slice === slice);
        return (
          <View key={slice}>
            <Rule />
            <Text style={styles.markTitle}>Mark {markNumber(slice)}</Text>
            <View style={styles.derivedGrid}>
              {keys.map((key) => (
                <View key={key} style={styles.derivedCell}>
                  <Body variant="caption" color={colors.textSecondary}>
                    {fieldLabel(key).replace(/ at mark \d$/, '')}
                    {estimated.has(key) ? ', estimated' : ''}
                  </Body>
                  {flow.advanced ? (
                    <MmInput
                      compact
                      label={fieldLabel(key)}
                      value={flow.overrideTexts[key] ?? valueText(flow.values[key])}
                      placeholder={valueText(flow.values[key])}
                      onChangeText={(text) => flow.setOverride(key, text)}
                      error={errors[key]}
                    />
                  ) : (
                    <>
                      <Text style={styles.derivedValue}>{valueText(flow.values[key]) || '-'}</Text>
                      {errors[key] && (
                        <Body variant="caption" color={colors.danger}>
                          {errors[key]}
                        </Body>
                      )}
                    </>
                  )}
                  {flow.diffs.get(key) && (
                    <Body variant="caption" color={colors.textSecondary}>
                      {formatDiff(flow.diffs.get(key)!)}
                    </Body>
                  )}
                </View>
              ))}
            </View>
          </View>
        );
      })}
      <Rule />

      <Pressable
        onPress={() => flow.setAdvanced(!flow.advanced)}
        accessibilityRole="switch"
        accessibilityState={{ checked: flow.advanced }}
        accessibilityLabel="Advanced: edit all 25 values"
        style={styles.toggle}
      >
        <View style={[styles.checkbox, flow.advanced && styles.checkboxOn]}>
          {flow.advanced && <View style={styles.checkboxMark} />}
        </View>
        <Body variant="bodyStrong">Advanced: edit all 25</Body>
      </Pressable>

      <View style={{ height: spacing.xl }} />
      {flow.submitError && (
        <View accessibilityLiveRegion="polite" role="alert" style={{ marginBottom: spacing.md }}>
          <Body variant="bodyStrong" color={colors.danger}>
            Not sent. {flow.submitError}
          </Body>
        </View>
      )}
      <View style={styles.actions}>
        <Button onPress={onSubmit} disabled={!flow.canSubmit}>
          {flow.submitting ? 'Sending' : 'Send measurements'}
        </Button>
        <Button variant="outline" onPress={onCancel} disabled={flow.submitting}>
          Cancel
        </Button>
      </View>
      <View style={{ height: spacing.md }} />
      <Body variant="caption" color={colors.textSecondary} style={styles.reading}>
        {adjust && !flow.changed
          ? 'Change a value to send it.'
          : 'We check every value again before anything is made.'}
      </Body>
    </>
  );
}

function valueText(value: number | undefined): string {
  return value === undefined ? '' : String(Math.round(value * 10) / 10);
}

function ReviewRow({
  field,
  flow,
  error,
  onPress,
}: {
  field: MeasurementKey;
  flow: ManualMeasurementsState;
  error?: string;
  onPress: () => void;
}) {
  const value = flow.values[field];
  const diff = flow.diffs.get(field);
  const shown = value === undefined ? 'Not measured' : formatMm(value);
  return (
    <>
      <Rule />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${fieldLabel(field)}, ${shown}. Measure again.`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.rowText}>
          <Body variant="bodyStrong">{fieldLabel(field)}</Body>
          {diff && (
            <Body variant="bodySmall" color={colors.textSecondary}>
              Scan {formatMm(diff.scanned)}, change {formatDiff(diff)}
            </Body>
          )}
          {error && (
            <Body variant="bodySmall" color={colors.danger}>
              {error}
            </Body>
          )}
        </View>
        <Text style={[styles.rowValue, field === LEG_LENGTH && styles.rowValueLarge]}>
          {value === undefined ? '-' : valueText(value)}
          <Text style={styles.rowUnit}> mm</Text>
        </Text>
      </Pressable>
      {diff?.big && <BigChange />}
    </>
  );
}

const styles = StyleSheet.create({
  reading: { maxWidth: 520 },
  instruction: { maxWidth: 520, marginBottom: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  needRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  needNumber: { ...typography.h3, color: colors.textPrimary, minWidth: 32 },
  counterRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  counter: { ...typography.display, color: colors.brick[500] },
  progress: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.sm, maxWidth: 360 },
  segment: { flex: 1, height: 4 },
  diagramBand: {
    marginHorizontal: -spacing.lg,
    marginVertical: spacing.lg,
    paddingVertical: spacing.lg,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    backgroundColor: colors.surfaceMuted,
  },
  diagram: { maxWidth: 340 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 64,
    minWidth: 200,
    borderWidth: 2,
    borderRadius: radius,
    borderColor: colors.textSecondary,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
  fieldCompact: { minHeight: 48, minWidth: 0, alignSelf: 'stretch', paddingHorizontal: spacing.sm },
  fieldFocused: { borderColor: colors.textPrimary, backgroundColor: colors.surfaceMuted },
  fieldError: { borderColor: colors.danger },
  input: {
    ...typography.h2,
    flex: 1,
    minWidth: 120,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null),
  },
  inputCompact: { ...typography.bodyStrong, minWidth: 48 },
  unit: { ...typography.bodyStrong, color: colors.textSecondary, marginLeft: spacing.sm },
  unitCompact: { ...typography.caption, color: colors.textSecondary },
  bigChange: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, maxWidth: 520 },
  bigChangeBar: { width: 4, alignSelf: 'stretch', backgroundColor: colors.action },
  strong: { fontFamily: typography.label.fontFamily },
  reviewSplit: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xl },
  reviewList: { flexGrow: 1, flexBasis: 300, maxWidth: 560 },
  reviewDiagram: { width: 220 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 56,
  },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  rowText: { flex: 1, gap: spacing.xs },
  rowValue: { ...typography.h3, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  rowValueLarge: { ...typography.h2 },
  rowUnit: { ...typography.caption, color: colors.textSecondary },
  markTitle: { ...typography.h3, color: colors.textPrimary, marginBottom: spacing.sm },
  derivedGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.md },
  derivedCell: { flexBasis: '50%', paddingRight: spacing.md, gap: spacing.xs, minWidth: 140 },
  derivedValue: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    alignSelf: 'flex-start',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.textPrimary,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.textPrimary },
  checkboxMark: { width: 10, height: 10, backgroundColor: colors.yellow },
});
