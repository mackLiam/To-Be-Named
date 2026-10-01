import type { Measurements } from '@forms/shared';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  DEFAULT_TEMPLATE,
  computeFitPreview,
  maxHalfExtent,
  toSvgPath,
  type FitPreviewGeometry,
  type GuardTemplate,
  type ViewOutline,
} from '../lib/fitPreview';
import { colors, radius, spacing, typography } from '../theme/tokens';
import { Body } from './Body';

export interface FitPreviewProps {
  /** Validated measurements for the left leg, mm. */
  left?: Measurements;
  /** Validated measurements for the right leg, mm. */
  right?: Measurements;
  /** Templates to offer; a switcher appears when there is more than one. Defaults to Club. */
  templates?: readonly GuardTemplate[];
  /** Template id selected first; falls back to the first template. */
  initialTemplate?: string;
}

type Side = 'left' | 'right';

const DRAW_HEIGHT = 240;
const PAD_MM = 12;

/**
 * Approximate pre-purchase fit preview from scan measurements only. Front and
 * side views share one mm-to-px scale so their proportions are honest. Sits on
 * a stud brown block: yellow leg line, bright brick shell (graphic accent on
 * brown, allowed at any size there).
 */
export function FitPreview({
  left,
  right,
  templates = [DEFAULT_TEMPLATE],
  initialTemplate,
}: FitPreviewProps) {
  const [templateId, setTemplateId] = useState(
    templates.find((t) => t.id === initialTemplate)?.id ?? templates[0]?.id,
  );
  const template = templates.find((t) => t.id === templateId) ?? templates[0] ?? DEFAULT_TEMPLATE;

  const legs = useMemo(() => {
    const out: { side: Side; geometry: FitPreviewGeometry }[] = [];
    for (const [side, values] of [
      ['left', left],
      ['right', right],
    ] as const) {
      if (!values) continue;
      const result = computeFitPreview(values, template);
      if (result.ok) out.push({ side, geometry: result });
    }
    return out;
  }, [left, right, template]);

  const [side, setSide] = useState<Side>('left');
  const current = legs.find((l) => l.side === side) ?? legs[0];

  if (!current) {
    return left || right ? (
      <View style={styles.notice}>
        <Body variant="bodyStrong" color={colors.danger}>
          The fit preview failed to draw.
        </Body>
        <Body variant="bodySmall" color={colors.textSecondary}>
          Some measurements from this scan are missing or out of range. A rescan fixes it.
        </Body>
      </View>
    ) : (
      <View style={styles.notice}>
        <Body variant="bodySmall" color={colors.textSecondary}>
          Your fit preview appears here once the scan is measured.
        </Body>
      </View>
    );
  }

  const { geometry } = current;
  const heightMm = Math.round(geometry.summary.guardHeightMm);
  const widthMm = Math.round(geometry.summary.guardMaxWidthMm);
  const legName = current.side === 'left' ? 'Left' : 'Right';

  return (
    <View style={styles.root}>
      {(legs.length > 1 || templates.length > 1) && (
        <View style={styles.switchers}>
          {legs.length > 1 && (
            <Segmented
              options={legs.map((l) => ({
                id: l.side,
                label: l.side === 'left' ? 'Left leg' : 'Right leg',
              }))}
              value={current.side}
              onChange={(id) => setSide(id as Side)}
            />
          )}
          {templates.length > 1 && (
            <Segmented
              options={templates.map((t) => ({ id: t.id, label: t.name }))}
              value={template.id}
              onChange={setTemplateId}
            />
          )}
        </View>
      )}

      <View
        style={styles.block}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${legName} leg, ${template.name} guard preview: about ${heightMm} millimetres tall and ${widthMm} millimetres wide at its widest.`}
      >
        <View style={styles.views}>
          <Drawing label="Front" view={geometry.front} legLength={geometry.legLengthMm} />
          <Drawing label="Side" view={geometry.side} legLength={geometry.legLengthMm} />
        </View>
        <View style={styles.stats}>
          <Stat label="Guard height" value={heightMm} />
          <Stat label="Max width" value={widthMm} />
        </View>
      </View>

      <Body variant="caption" color={colors.textSecondary} style={styles.caption}>
        An approximate preview from your scan measurements. Your guard is made from the full CAD
        model.
      </Body>
    </View>
  );
}

function Drawing({
  label,
  view,
  legLength,
}: {
  label: string;
  view: ViewOutline;
  legLength: number;
}) {
  const half = maxHalfExtent(view) + PAD_MM;
  const vbHeight = legLength + 2 * PAD_MM;
  const width = (2 * half * DRAW_HEIGHT) / vbHeight;
  return (
    <View>
      <Text style={styles.viewLabel}>{label}</Text>
      <Svg
        width={width}
        height={DRAW_HEIGHT}
        viewBox={`${-half} ${-(legLength + PAD_MM)} ${2 * half} ${vbHeight}`}
      >
        <Path
          d={toSvgPath(view.leg)}
          fill={colors.brown[700]}
          stroke={colors.yellow}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <Path
          d={toSvgPath(view.guard)}
          fill={colors.accentOnDark}
          fillOpacity={0.55}
          stroke={colors.accentOnDark}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>
        {value}
        <Text style={styles.statUnit}> mm</Text>
      </Text>
    </View>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o, i) => {
        const selected = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.segment, i > 0 && styles.segmentDivider, selected && styles.segmentOn]}
          >
            <Text style={[styles.segmentLabel, selected && styles.segmentLabelOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  switchers: { gap: spacing.sm, alignItems: 'flex-start' },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: radius,
    overflow: 'hidden',
  },
  segment: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  segmentDivider: { borderLeftWidth: 1, borderLeftColor: colors.textPrimary },
  segmentOn: { backgroundColor: colors.surfaceDark },
  segmentLabel: { ...typography.label, textTransform: 'uppercase', color: colors.textPrimary },
  segmentLabelOn: { color: colors.onDark },
  block: {
    backgroundColor: colors.surfaceDark,
    borderRadius: radius,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    gap: spacing.lg,
  },
  views: { flexDirection: 'row', gap: spacing.xl, alignItems: 'flex-end' },
  viewLabel: {
    ...typography.label,
    textTransform: 'uppercase',
    color: colors.onDarkMuted,
    marginBottom: spacing.sm,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.brown[700],
    paddingTop: spacing.md,
  },
  statLabel: { ...typography.label, textTransform: 'uppercase', color: colors.onDarkMuted },
  statValue: { ...typography.h1, color: colors.onDark },
  statUnit: { ...typography.h3, color: colors.onDarkMuted },
  caption: { maxWidth: 320 },
  notice: {
    backgroundColor: colors.surfaceMuted,
    borderLeftWidth: 4,
    borderLeftColor: colors.textPrimary,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    gap: spacing.xs,
  },
});
