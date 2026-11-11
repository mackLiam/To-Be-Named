import { View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

import { BRAND_NAME } from '@forms/shared/brand';

import { wordmarkColors, type WordmarkSurface } from '../lib/uiState';
import {
  WORDMARK_ASPECT,
  WORDMARK_LETTERS,
  WORDMARK_O,
  WORDMARK_O_OFFSET_X,
  WORDMARK_O_STROKE,
  WORDMARK_VIEWBOX,
} from './wordmarkPaths';

/**
 * The FORMS wordmark from the designer's paths. `surface` is what it sits on,
 * which picks the only allowed pairing for that background.
 */
export function Wordmark({ surface, height }: { surface: WordmarkSurface; height: number }) {
  const { letters, o } = wordmarkColors(surface);
  // Accessibility props live on the View: react-native-svg forwards them to
  // the DOM <svg> on web, where `accessible` is not a valid attribute.
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={BRAND_NAME}>
      <Svg width={height * WORDMARK_ASPECT} height={height} viewBox={WORDMARK_VIEWBOX}>
        <Path d={WORDMARK_LETTERS} fill={letters} />
        <G x={WORDMARK_O_OFFSET_X}>
          <Path d={WORDMARK_O} fill="none" stroke={o} strokeWidth={WORDMARK_O_STROKE} />
        </G>
      </Svg>
    </View>
  );
}
