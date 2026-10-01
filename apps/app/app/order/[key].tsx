import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Screen } from '../../src/components/Screen';
import { useAccount } from '../../src/hooks/useAccount';
import { useCheckout } from '../../src/hooks/useCheckout';
import { useProducts } from '../../src/hooks/useProducts';
import { useScanSession } from '../../src/hooks/useScans';
import type { Product } from '../../src/lib/api';
import { checkoutErrorMessage, formatMoney, orderTotalCents } from '../../src/lib/checkout';
import { LEG_LABEL, orderableLegs } from '../../src/lib/library';
import { colors, radius, spacing } from '../../src/theme/tokens';

export default function OrderScreen() {
  const router = useRouter();
  // product: preselected when arriving from the Shop.
  const { key, product: productParam } = useLocalSearchParams<{ key: string; product?: string }>();
  const scan = useScanSession(key ?? '');
  const products = useProducts();
  const { account } = useAccount();
  const checkout = useCheckout();
  const [pickedId, setPickedId] = useState<string | null>(productParam ?? null);

  const legs = scan.session ? orderableLegs(scan.session, scan.measurements) : [];

  if (!scan.session || (legs.length === 0 && scan.loading)) {
    return (
      <Screen onRefresh={scan.reload} refreshing={false}>
        {scan.loading ? (
          <ActivityIndicator color={colors.textPrimary} />
        ) : scan.error ? (
          <Body color={colors.danger}>Could not load this scan. Pull down to try again.</Body>
        ) : (
          <Heading level="h2">Scan not found</Heading>
        )}
      </Screen>
    );
  }

  const sessionKey = scan.session.key;
  const backToScan = () => router.navigate(`/scan/${sessionKey}`);

  if (legs.length === 0) {
    return (
      <Screen
        onRefresh={scan.reload}
        refreshing={scan.loading}
        footer={
          <Button variant="outline" onPress={backToScan}>
            Back to the scan
          </Button>
        }
      >
        <Heading level="h1">Nothing to order yet</Heading>
        <View style={{ height: spacing.md }} />
        <Body color={colors.textSecondary}>This scan is still being measured.</Body>
      </Screen>
    );
  }

  const product: Product | undefined =
    products.data.find((candidate) => candidate.id === pickedId) ?? products.data[0];

  const member = account?.kind === 'member';
  const footer = product ? (
    member ? (
      <Button
        disabled={checkout.busy}
        onPress={() => checkout.start({ productId: product.id, legs })}
      >
        {checkout.busy ? 'Opening payment' : 'Continue to payment'}
      </Button>
    ) : (
      <Button onPress={() => router.navigate('/profile')}>Save to an account</Button>
    )
  ) : undefined;

  return (
    <Screen onRefresh={products.reload} refreshing={products.loading} footer={footer}>
      <Heading level="display">{legs.length === 1 ? 'Your guard' : 'Your pair'}</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary}>
        {legs.map((leg) => LEG_LABEL[leg.leg]).join(' and ')}, printed to this scan.
      </Body>
      <View style={{ height: spacing.xl }} />

      {products.loading && products.data.length === 0 && (
        <ActivityIndicator color={colors.textPrimary} />
      )}
      {products.error && (
        <Body color={colors.danger}>Could not load guards. Pull down to try again.</Body>
      )}
      {!products.loading && !products.error && products.data.length === 0 && (
        <Body color={colors.textSecondary}>No guards on sale right now.</Body>
      )}
      <View accessibilityRole="radiogroup" style={styles.options}>
        {products.data.map((option) => {
          const selected = option.id === product?.id;
          return (
            <Pressable
              key={option.id}
              onPress={() => setPickedId(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <View style={styles.optionHeader}>
                <Heading level="h3" style={styles.optionName}>
                  {option.name}
                </Heading>
                <Body variant="bodyStrong">{formatMoney(option.priceCents, option.currency)}</Body>
              </View>
              <Body variant="bodySmall" color={colors.textSecondary}>
                {option.description}
              </Body>
            </Pressable>
          );
        })}
      </View>

      {product && (
        <View style={styles.total}>
          <View style={styles.totalRow}>
            <Body color={colors.textSecondary}>
              {legs.length === 1 ? 'Total, one guard' : 'Total, two guards'}
            </Body>
            <Heading level="h2">
              {formatMoney(orderTotalCents(product.priceCents, legs.length), product.currency)}
            </Heading>
          </View>
          <Body variant="caption" color={colors.textSecondary}>
            {member ? 'Secure payment with Stripe.' : 'Ordering needs an account.'}
          </Body>
          {member && checkout.error && (
            <Body color={colors.danger}>{checkoutErrorMessage(checkout.error)}</Body>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  options: {
    gap: spacing.sm,
  },
  option: {
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing.md,
    gap: spacing.xs,
  },
  optionSelected: {
    borderColor: colors.textPrimary,
    backgroundColor: colors.surfaceMuted,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.md,
  },
  optionName: {
    flex: 1,
  },
  total: {
    marginTop: spacing.xl,
    gap: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
});
