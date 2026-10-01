import type { MeasurementKey } from '@forms/shared';
import { View } from 'react-native';
import Svg, { Ellipse, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { SLICES } from '../lib/library';
import {
  LEG_LENGTH,
  SLICE_FRACTIONS,
  formatMmShort,
  markNumber,
  parseKey,
  type Slice,
} from '../lib/manualMeasurements';
import { colors, fontFamily } from '../theme/tokens';

export type DiagramView = 'front' | 'side';

interface MeasureDiagramProps {
  view: DiagramView;
  /** Field being entered: Leg_Length, or an OW (front) / OD (side) key. */
  active: MeasurementKey | null;
  /** Mark heights from the entered Leg_Length; null shows percentages. */
  heights: Record<Slice, number> | null;
}

// Illustrative, not to scale. viewBox units; t runs 0 at the ankle point
// (narrowest part above the ankle bones) to 1 at the dip below the kneecap,
// the same two landmarks the scan's leg axis runs between.
const VB_W = 260;
const VB_H = 420;
const CX = 112;
const Y_ANKLE = 360;
const Y_KNEE = 60;
const DIM_X = 22;
const LABEL_X = 178;
const BOOK_W = 10;
const BOOK_H = 64;

const yAt = (t: number) => Y_ANKLE - t * (Y_ANKLE - Y_KNEE);

/** Front silhouette half width: ankle bones below t=0, calf peak near 0.7. */
function frontHalf(t: number): number {
  if (t < 0) return 21 + 10 * Math.sin((Math.min(-t, 0.12) / 0.12) * (Math.PI / 2));
  if (t <= 0.7) return 21 + 34 * Math.sin((t / 0.7) * (Math.PI / 2)) ** 1.4;
  return 55 - 10 * ((t - 0.7) / 0.42) ** 2;
}

/** Side view: shin (front, left) is near straight; calf (back, right) bulges. */
function sideFront(t: number): number {
  const knee = t > 0.98 ? 7 * Math.sin(((t - 0.98) / 0.14) * Math.PI) : 0;
  return CX - 22 - 5 * t - knee;
}
function sideBack(t: number): number {
  if (t <= 0.72) return CX + 18 + 42 * Math.sin((Math.max(t, 0) / 0.72) * (Math.PI / 2)) ** 1.6;
  return CX + 60 - 18 * ((t - 0.72) / 0.4) ** 2;
}

function edge(x: (t: number) => number, t0: number, t1: number): string {
  const n = 48;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / n;
    return `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${yAt(t).toFixed(1)}`;
  }).join(' ');
}

const FRONT_LEFT = edge((t) => CX - frontHalf(t), -0.12, 1.12);
const FRONT_RIGHT = edge((t) => CX + frontHalf(t), -0.12, 1.12);
const SIDE_FRONT = edge(sideFront, 0, 1.12);
const SIDE_BACK = edge(sideBack, 0, 1.12);
const SIDE_FOOT = [
  `M${sideBack(0)} ${Y_ANKLE}`,
  `C${sideBack(0) + 6} 386 ${sideBack(0) + 6} 408 ${sideBack(0) - 6} 410`,
  'L40 410',
  'Q28 410 30 400',
  `C44 390 ${sideFront(0) - 8} 384 ${sideFront(0)} ${Y_ANKLE}`,
].join(' ');

/** Leg edges at a height, for the books and the dimension arrow. */
function edgesAt(view: DiagramView, t: number): [number, number] {
  return view === 'front' ? [CX - frontHalf(t), CX + frontHalf(t)] : [sideFront(t), sideBack(t)];
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  color,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}) {
  const head = 7;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const tip = (x: number, y: number, dir: number) => {
    const a = angle + dir;
    const p = (s: number) => `${x - head * Math.cos(a + s)},${y - head * Math.sin(a + s)}`;
    return `${x},${y} ${p(0.45)} ${p(-0.45)}`;
  };
  return (
    <G>
      <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={3} />
      <Polygon points={tip(x2, y2, 0)} fill={color} />
      <Polygon points={tip(x1, y1, Math.PI)} fill={color} />
    </G>
  );
}

function Label({
  y,
  title,
  value,
  strong,
}: {
  y: number;
  title: string;
  value?: string;
  strong?: boolean;
}) {
  return (
    <G>
      <SvgText
        x={LABEL_X}
        y={y - 2}
        fontFamily={fontFamily.bodyBold}
        fontSize={11}
        letterSpacing={0.6}
        fill={strong ? colors.textPrimary : colors.textSecondary}
      >
        {title.toUpperCase()}
      </SvgText>
      {value ? (
        <SvgText
          x={LABEL_X}
          y={y + 13}
          fontFamily={strong ? fontFamily.headingBold : fontFamily.bodyMedium}
          fontSize={strong ? 15 : 12}
          fill={colors.textPrimary}
        >
          {value}
        </SvgText>
      ) : null}
    </G>
  );
}

function describe(
  view: DiagramView,
  active: MeasurementKey | null,
  heights: MeasureDiagramProps['heights'],
) {
  const side = view === 'front' ? 'Front view of a lower leg' : 'Side view of a lower leg';
  const parsed = active ? parseKey(active) : null;
  if (active === LEG_LENGTH) {
    return `${side}. Leg length runs from the narrowest part just above the ankle bones up to the soft dip just below the kneecap.`;
  }
  if (parsed) {
    const n = markNumber(parsed.slice);
    const height = heights
      ? `, ${formatMmShort(heights[parsed.slice])} up from the ankle point`
      : '';
    return parsed.dim === 'OW'
      ? `${side}. Two books held upright against each side of the leg at mark ${n}${height}. Measure the gap between them.`
      : `${side}. One book against the front of the shin and one against the back of the calf at mark ${n}${height}. Measure the gap between them.`;
  }
  return `${side} with four marks between the ankle point and the knee.`;
}

/**
 * Where to measure from and between: open line art of a lower leg on the
 * yellow field. Brick marks only the active measurement; the books are solid
 * stud brown bars. Text stays brown (contrast on yellow).
 */
export function MeasureDiagram({ view, active, heights }: MeasureDiagramProps) {
  const parsed = active ? parseKey(active) : null;
  const activeSlice = parsed && (parsed.dim === 'OW' || parsed.dim === 'OD') ? parsed.slice : null;
  const lengthActive = active === LEG_LENGTH;
  const dimTone = lengthActive ? colors.brick[500] : colors.disabled;
  const [front0, front1] = edgesAt('front', 0);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={describe(view, active, heights)}
      style={{ width: '100%', aspectRatio: VB_W / VB_H }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${VB_W} ${VB_H}`}>
        {/* Leg */}
        {view === 'front' ? (
          <G>
            <Path
              d={FRONT_LEFT}
              stroke={colors.textPrimary}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
            <Path
              d={FRONT_RIGHT}
              stroke={colors.textPrimary}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
            <Ellipse
              cx={CX}
              cy={yAt(1.07)}
              rx={21}
              ry={16}
              stroke={colors.textPrimary}
              strokeWidth={1.5}
              fill="none"
            />
          </G>
        ) : (
          <G>
            <Path
              d={SIDE_FRONT}
              stroke={colors.textPrimary}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
            <Path
              d={SIDE_BACK}
              stroke={colors.textPrimary}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
            <Path
              d={SIDE_FOOT}
              stroke={colors.textPrimary}
              strokeWidth={2.5}
              fill="none"
              strokeLinejoin="round"
            />
          </G>
        )}

        {/* Leg length: ankle point to the dip below the kneecap */}
        {view === 'front' && (
          <G>
            <Line
              x1={DIM_X}
              y1={Y_ANKLE}
              x2={front0}
              y2={Y_ANKLE}
              stroke={dimTone}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <Line
              x1={DIM_X}
              y1={Y_KNEE}
              x2={CX - frontHalf(1)}
              y2={Y_KNEE}
              stroke={dimTone}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {lengthActive ? (
              <Arrow x1={DIM_X} y1={Y_ANKLE} x2={DIM_X} y2={Y_KNEE} color={colors.brick[500]} />
            ) : (
              <Line
                x1={DIM_X}
                y1={Y_ANKLE}
                x2={DIM_X}
                y2={Y_KNEE}
                stroke={dimTone}
                strokeWidth={1.5}
              />
            )}
            <Label y={Y_KNEE} title="Below kneecap" strong={lengthActive} />
            <Label y={Y_ANKLE + 4} title="Ankle point" strong={lengthActive} />
            <Line
              x1={front1}
              y1={Y_ANKLE}
              x2={LABEL_X - 6}
              y2={Y_ANKLE}
              stroke={dimTone}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          </G>
        )}

        {/* The four marks */}
        {SLICES.map((slice) => {
          const t = SLICE_FRACTIONS[slice];
          const y = yAt(t);
          const [a] = edgesAt(view, t);
          const on = slice === activeSlice;
          return (
            <G key={slice}>
              <Line
                x1={a - 6}
                y1={y}
                x2={LABEL_X - 6}
                y2={y}
                stroke={on ? colors.brick[500] : colors.disabled}
                strokeWidth={on ? 1.5 : 1}
                strokeDasharray={on ? undefined : '3 3'}
              />
              <Label
                y={y}
                title={`Mark ${markNumber(slice)}`}
                value={heights ? formatMmShort(heights[slice]) : `${Math.round(t * 100)}% up`}
                strong={on}
              />
            </G>
          );
        })}

        {/* Books and the gap to measure */}
        {activeSlice &&
          (() => {
            const t = SLICE_FRACTIONS[activeSlice];
            const y = yAt(t);
            const [a, b] = edgesAt(view, t);
            return (
              <G>
                <Rect
                  x={a - BOOK_W}
                  y={y - BOOK_H / 2}
                  width={BOOK_W}
                  height={BOOK_H}
                  fill={colors.surfaceDark}
                />
                <Rect
                  x={b}
                  y={y - BOOK_H / 2}
                  width={BOOK_W}
                  height={BOOK_H}
                  fill={colors.surfaceDark}
                />
                <Arrow
                  x1={a + 2}
                  y1={y - BOOK_H / 2 + 8}
                  x2={b - 2}
                  y2={y - BOOK_H / 2 + 8}
                  color={colors.brick[500]}
                />
              </G>
            );
          })()}
      </Svg>
    </View>
  );
}
