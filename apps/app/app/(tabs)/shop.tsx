import { useRouter } from 'expo-router';
import { Image, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useAccount } from '../../src/hooks/useAccount';
import { useProducts } from '../../src/hooks/useProducts';
import { canPlaceOrder } from '../../src/lib/auth';
import { colors, radius, spacing } from '../../src/theme/tokens';

export default function ShopScreen() {
  const { data: products, loading, error } = useProducts();
  const { account } = useAccount();
  const router = useRouter();

  return (
    <Screen>
      <Heading level="display">Built from your scan.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        One guard model, sized to you. No S/M/L guesswork, no gap at the ankle, no shin bone digging
        into a hard shell that does not fit.
      </Body>
      <Rule />

      {!canPlaceOrder(account) && (
        <View style={{ backgroundColor: colors.surfaceMuted, padding: spacing.lg }}>
          <Heading level="h3">Ordering needs an account.</Heading>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall">
            You are in guest mode. Save your scans to an account from Profile, it takes one code,
            then order here.
          </Body>
          <View style={{ height: spacing.md }} />
          <Button variant="outline" onPress={() => router.push('/profile')}>
            Save my scans
          </Button>
        </View>
      )}
      {!canPlaceOrder(account) && <Rule />}

      {loading && <Body color={colors.textSecondary}>Loading the shop.</Body>}

      {error && (
        <Body color={colors.danger}>Could not load products right now. Try again shortly.</Body>
      )}

      {!loading && !error && products.length === 0 && (
        <View>
          <Heading level="h3">Products connect here next.</Heading>
          <View style={{ height: spacing.sm }} />
          <Body color={colors.textSecondary}>
            The shop needs a completed scan before it can quote a guard for you. Once your Supabase
            project is connected, the catalog and pricing load in this tab automatically.
          </Body>
        </View>
      )}

      {products.map((product) => (
        <View key={product.id}>
          {product.image && (
            <Image
              accessibilityIgnoresInvertColors
              alt={product.name}
              source={product.image}
              style={{
                // Explicit height, not aspectRatio: a bundled asset brings its
                // own intrinsic height into the style, and with both set yoga
                // ignores aspectRatio.
                width: '100%',
                height: 190,
                borderRadius: radius,
                backgroundColor: colors.surfaceMuted,
                marginBottom: spacing.md,
              }}
            />
          )}
          <Body variant="bodyStrong">{product.name}</Body>
          <Body color={colors.textSecondary} variant="bodySmall">
            {product.description}
          </Body>
          <Body variant="bodyStrong">
            {(product.priceCents / 100).toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
            })}
          </Body>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}
