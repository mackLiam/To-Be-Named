import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme/tokens';

interface ScreenProps extends PropsWithChildren {
  scroll?: boolean;
}

/**
 * Base page frame: white field, generous left-aligned margins, no centered
 * max-width container. Every tab screen wraps its content in this so spacing
 * stays consistent without every screen re-deriving it.
 */
export function Screen({ children, scroll = true }: ScreenProps) {
  const Container = scroll ? ScrollView : View;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <Container
        style={styles.container}
        contentContainerStyle={scroll ? styles.content : undefined}
      >
        {scroll ? children : <View style={styles.content}>{children}</View>}
      </Container>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
});
