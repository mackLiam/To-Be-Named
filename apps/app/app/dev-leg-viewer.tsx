import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '../src/components/Button';
import { LegViewer } from '../src/components/LegViewer';
import { GUARD_TEMPLATES, type GuardTemplateId } from '../src/lib/fitPreview';
import { colors, spacing } from '../src/theme/tokens';

/**
 * Dev-only viewer check (Phase 2 spike, SCAN-V3-PLAN.md 7.6). Linked from
 * nowhere; production builds redirect home. Shows the synthetic shared
 * fixture, never a user's leg.
 */
export default function DevLegViewerRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <DevLegViewer />;
}

function DevLegViewer() {
  const [model, setModel] = useState<unknown>(null);
  const [templateId, setTemplateId] = useState<GuardTemplateId>('club');

  // Dynamic so the fixture never lands in the production entry bundle.
  useEffect(() => {
    let live = true;
    void import('../../../packages/shared/tests/fixtures/leg-model-v1/valid-python-output.json').then(
      (m) => {
        if (live) setModel(m.default);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.stage}>
        {model !== null ? <LegViewer model={model} template={GUARD_TEMPLATES[templateId]} /> : null}
      </View>
      <View style={styles.row}>
        {(Object.keys(GUARD_TEMPLATES) as GuardTemplateId[]).map((id) => (
          <Button
            key={id}
            variant={id === templateId ? 'primary' : 'outline'}
            onPress={() => setTemplateId(id)}
            style={styles.flex}
          >
            {GUARD_TEMPLATES[id].name}
          </Button>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  stage: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  flex: { flex: 1 },
});
