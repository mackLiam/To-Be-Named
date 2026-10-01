import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useAccount } from '../../src/hooks/useAccount';
import { useCheckout } from '../../src/hooks/useCheckout';
import { useProducts } from '../../src/hooks/useProducts';
import { useScanSession } from '../../src/hooks/useScans';
import type { Product } from '../../src/lib/api';
import { checkoutErrorMessage, formatMoney, orderTotalCents } from '../../src/lib/checkout';
import { LEG_LABEL, orderableLegs } from '../../src/lib/library';
import { colors, spacing } from '../../src/theme/tokens';

export default function OrderScreen() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const scan = useScanSession(key ?? '');
  const products = useProducts();
  const { account } = useAccount();
  const checkout = useCheckout();
  const [pickedId, setPickedId] = useState<string | null>(null);

  const legs = scan.session ? orderableLegs(scan.session, scan.measurements) : [];

  if (!scan.session || (legs.length === 0 && scan.loading)) {
    return (
      <Screen onRefresh={scan.reload} refreshing={false}>
        {scan.loading ? (
          <Body color={colors.textSecondary}>Loading this scan.</Body>
        ) : scan.error ? (
          <Body color={colors.danger}>Could not load this scan. Pull down to try again.</Body>
        ) : (
          <>
            <Heading level="h2">Scan not found.</Heading>
            <View style={{ height: spacing.sm }} />
            <Body color={colors.textSecondary}>It may have been removed from your library.</Body>
          </>
        )}
      </Screen>
    );
  }

  const sessionKey = scan.session.key;
  const backToScan = () => router.navigate(`/scan/${sessionKey}`);

  if (legs.length === 0) {
    return (
      <Screen onRefresh={scan.reload} refreshing={scan.loading}>
        <Heading level="h1">Nothing to order yet.</Heading>
        <View style={{ height: spacing.sm }} />
        <Body color={colors.textSecondary}>
          No leg in this scan has finished measuring. Guards are made only from measured legs.
        </Body>
        <View style={{ height: spacing.lg }} />
        <Button variant="outline" onPress={backToScan}>
          Back to the scan
        </Button>
      </Screen>
    );
  }

  const product: Product | undefined =
    products.data.find((candidate) => candidate.id === pickedId) ?? products.data[0];

  return (
    <Screen onRefresh={products.reload} refreshing={products.loading}>
      <Body variant="label" color={colors.textSecondary}>
        Order
      </Body>
      <View style={{ height: spacing.sm }} />
      <Heading level="h1">{legs.length === 1 ? 'Your guard.' : 'Your pair.'}</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        {legs.length === 1 ? 'One guard' : 'Two guards'}, printed to this scan:{' '}
        {legs.map((leg) => LEG_LABEL[leg.leg].toLowerCase()).join(' and ')}.
      </Body>
      <Rule />

      <Heading level="h3">Choose your guard</Heading>
      <View style={{ height: spacing.md }} />
      {products.loading && products.data.length === 0 && (
        <Body color={colors.textSecondary}>Loading guards.</Body>
      )}
      {products.error && (
        <Body color={colors.danger}>Could not load guards. Pull down to try again.</Body>
      )}
      {!products.loading && !products.error && products.data.length === 0 && (
        <Body color={colors.textSecondary}>No guards are on sale right now. Check back soon.</Body>
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
                <Body variant="bodyStrong" style={styles.optionName}>
                  {option.name}
                </Body>
                <Body>{formatMoney(option.priceCents, option.currency)}</Body>
              </View>
              <Body variant="bodySmall" color={colors.textSecondary}>
                {option.description}
              </Body>
            </Pressable>
          );
        })}
      </View>

      {product && (
        <>
          <Rule />
          <View style={styles.total}>
            <Body color={colors.textSecondary}>
              {legs.length === 1 ? 'Total, one guard' : 'Total, two guards'}
            </Body>
            <Heading level="h3">
              {formatMoney(orderTotalCents(product.priceCents, legs.length), product.currency)}
            </Heading>
          </View>
          <View style={{ height: spacing.xs }} />
          <Body variant="caption" color={colors.textTertiary}>
            You pay on a secure Stripe page. The amount there is final.
          </Body>
          <View style={{ height: spacing.lg }} />

          {account?.kind === 'member' ? (
            <>
              <Button
                disabled={checkout.busy}
                onPress={() => checkout.start({ productId: product.id, legs })}
              >
                {checkout.busy ? 'Opening payment' : 'Continue to payment'}
              </Button>
              {checkout.error && (
                <>
                  <View style={{ height: spacing.sm }} />
                  <Body color={colors.danger}>{checkoutErrorMessage(checkout.error)}</Body>
                </>
              )}
            </>
          ) : (
            <View style={styles.guestPanel}>
              <Heading level="h3">Save your account to order.</Heading>
              <View style={{ height: spacing.xs }} />
              <Body variant="bodySmall" color={colors.textSecondary}>
                Guest scans live on this phone only. Orders need a saved account so we can reach you
                about delivery and you can track it on any device.
              </Body>
              <View style={{ height: spacing.md }} />
              <Button onPress={() => router.navigate('/profile')}>Save to an account</Button>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  options: {
    gap: spacing.sm,
  },
  option: {
    borderLeftWidth: 4,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionSelected: {
    borderLeftColor: colors.textPrimary,
    backgroundColor: colors.surfaceMuted,
  },
  optionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  optionName: {
    flex: 1,
  },
  total: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  guestPanel: {
    borderLeftWidth: 4,
    borderLeftColor: colors.textPrimary,
    paddingLeft: spacing.md,
  },
});
