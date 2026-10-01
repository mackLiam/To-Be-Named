import { useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Heading } from '../../src/components/Heading';
import { ListGroup, ListRow } from '../../src/components/List';
import { Screen } from '../../src/components/Screen';
import { useAccount } from '../../src/hooks/useAccount';
import { useProducts } from '../../src/hooks/useProducts';
import { canPlaceOrder } from '../../src/lib/auth';
import { formatMoney } from '../../src/lib/checkout';
import { colors, radius, spacing } from '../../src/theme/tokens';

export default function ShopScreen() {
  const { data: products, loading, error } = useProducts();
  const { account } = useAccount();
  const router = useRouter();

  return (
    <Screen title="Shop">
      {!canPlaceOrder(account) && (
        <ListGroup>
          <ListRow
            label="Save your scans to order"
            detail="Ordering needs an account."
            onPress={() => router.push('/profile')}
          />
        </ListGroup>
      )}

      {loading && <ActivityIndicator color={colors.textPrimary} />}

      {error && <Body color={colors.danger}>Could not load the shop. Try again shortly.</Body>}

      {!loading && !error && products.length === 0 && (
        <Body color={colors.textSecondary}>No guards on sale right now.</Body>
      )}

      {products.map((product) => (
        <View key={product.id} style={styles.product}>
          {product.image && (
            <Image
              accessibilityIgnoresInvertColors
              alt={product.name}
              source={product.image}
              style={styles.image}
            />
          )}
          <View style={styles.titleRow}>
            <Heading level="h2" style={styles.name}>
              {product.name}
            </Heading>
            <Heading level="h3">{formatMoney(product.priceCents, product.currency)}</Heading>
          </View>
          <Body color={colors.textSecondary}>{product.description}</Body>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  product: { marginBottom: spacing.xl, gap: spacing.sm },
  // Explicit height, not aspectRatio: a bundled asset brings its own intrinsic
  // height into the style, and with both set yoga ignores aspectRatio.
  image: {
    width: '100%',
    height: 240,
    borderRadius: radius,
    backgroundColor: colors.surfaceMuted,
    marginBottom: spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  name: { flex: 1 },
});
