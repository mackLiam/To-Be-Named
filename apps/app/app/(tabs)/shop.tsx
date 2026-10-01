import { useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { ListGroup, ListRow } from '../../src/components/List';
import { Screen } from '../../src/components/Screen';
import { useAccount } from '../../src/hooks/useAccount';
import { useProducts } from '../../src/hooks/useProducts';
import { useScanSessions } from '../../src/hooks/useScans';
import { canPlaceOrder } from '../../src/lib/auth';
import { formatMoney } from '../../src/lib/checkout';
import { newestOrderableSessionKey } from '../../src/lib/library';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

export default function ShopScreen() {
  const { data: products, loading, error } = useProducts();
  const { account } = useAccount();
  const { sessions } = useScanSessions();
  const router = useRouter();
  const member = canPlaceOrder(account);
  const orderFrom = newestOrderableSessionKey(sessions);

  return (
    <Screen title="Shop">
      {!member && (
        <ListGroup>
          <ListRow
            label="Save your scans to order"
            detail="Ordering needs an account."
            onPress={() => router.push('/profile')}
          />
        </ListGroup>
      )}
      {member && !orderFrom && (
        <ListGroup>
          <ListRow
            label="Scan your legs to order"
            detail="Guards are made from a measured scan."
            onPress={() => router.navigate('/')}
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
            <Text style={[typography.h3, styles.price]}>
              {formatMoney(product.priceCents, product.currency)}
            </Text>
          </View>
          <Body color={colors.textSecondary}>{product.description}</Body>
          {member && orderFrom && (
            <Button
              style={styles.action}
              accessibilityLabel={`Order ${product.name}`}
              onPress={() =>
                router.push({
                  pathname: '/order/[key]',
                  params: { key: orderFrom, product: product.id },
                })
              }
            >
              Order
            </Button>
          )}
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
  price: { color: colors.textPrimary },
  action: { marginTop: spacing.sm },
});
