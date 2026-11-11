import { requireOptionalNativeModule } from 'expo-modules-core';
import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { DEFAULT_TEMPLATE, type GuardTemplate } from '../lib/fitPreview';
import { bandMesh, buildLegGeometry, legViewerLabel } from '../lib/legGeometry';
import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';

// three.js and @react-three/fiber load only when this mounts with GL
// available (SCAN-V3-PLAN.md 7.6): the scene module is the only importer.
const LegViewerScene = lazy(() => import('./LegViewerScene'));

// Render-only outward offset of the band, in mm, so it does not z-fight the
// leg surface it lies on. Changes no measured quantity.
const BAND_LIFT_MM = 0.4;

type GlStatus = 'checking' | 'available' | 'unavailable';

// Checked after mount: web output is statically rendered in Node, where
// there is no document. A dev client built before expo-gl was added has no
// ExpoGL native module, and importing expo-gl there would throw.
function detectGl(): boolean {
  if (Platform.OS === 'web') {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
      return false;
    }
  }
  return requireOptionalNativeModule('ExpoGL') !== null;
}

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

// Catches a failed chunk load or GL context error. Never logs: the error
// may carry leg geometry.
class GlBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Fallback({ line }: { line: string }) {
  return (
    <View style={styles.fallback}>
      <Body color={colors.onDark}>{line}</Body>
    </View>
  );
}

export interface LegViewerProps {
  /** A forms.leg-model v1 document; validated here before anything is drawn. */
  model: unknown;
  template?: GuardTemplate;
  style?: StyleProp<ViewStyle>;
}

export function LegViewer({ model, template = DEFAULT_TEMPLATE, style }: LegViewerProps) {
  const [gl, setGl] = useState<GlStatus>('checking');
  useEffect(() => {
    setGl(detectGl() ? 'available' : 'unavailable');
  }, []);

  const built = useMemo(() => {
    const result = buildLegGeometry(model);
    if (!result.ok) return null;
    return {
      leg: result.leg,
      band: bandMesh(result.model, template, BAND_LIFT_MM),
      legLengthMm: result.model.leg_length_mm,
    };
  }, [model, template]);

  if (built === null) {
    return (
      <View style={[styles.stage, style]}>
        <Fallback line="This leg model cannot be shown." />
      </View>
    );
  }

  const fallback = <Fallback line="The 3D view is not available on this device." />;
  return (
    <View
      style={[styles.stage, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={legViewerLabel(template, built.legLengthMm)}
    >
      {gl === 'unavailable' ? fallback : null}
      {gl === 'available' ? (
        <GlBoundary fallback={fallback}>
          <Suspense fallback={null}>
            <LegViewerScene leg={built.leg} band={built.band} legLengthMm={built.legLengthMm} />
          </Suspense>
        </GlBoundary>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    backgroundColor: colors.surfaceDark,
    overflow: 'hidden',
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
});
