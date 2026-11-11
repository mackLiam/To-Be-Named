import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Screen } from '../../src/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '../../src/components/StateView';
import { useAccount } from '../../src/hooks/useAccount';
import { useCheckout } from '../../src/hooks/useCheckout';
import { useProducts } from '../../src/hooks/useProducts';
import { useScanSession } from '../../src/hooks/useScans';
import type { Product } from '../../src/lib/api';
import { canPlaceOrder } from '../../src/lib/auth';
import { checkoutErrorMessage, formatMoney, orderTotalCents } from '../../src/lib/checkout';
import { LEG_LABEL, orderableLegs } from '../../src/lib/library';
import { listView } from '../../src/lib/uiState';
import { colors, maxFontScale, radius, sizing, spacing, typography } from '../../src/theme/tokens';

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
          <LoadingState label="Loading this scan" />
        ) : scan.error ? (
          <ErrorState
            title="This scan did not load."
            line="Check your connection."
            onRetry={scan.reload}
          />
        ) : (
          <EmptyState title="Scan not found" line="It may have been deleted." />
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
        <EmptyState title="Nothing to order yet" line="This scan is still being measured." />
      </Screen>
    );
  }

  // The server refuses unpurchasable products; the picker never offers them.
  const options = products.data.filter((candidate) => candidate.purchasable);
  const product: Product | undefined =
    options.find((candidate) => candidate.id === pickedId) ?? options[0];

  const member = canPlaceOrder(account);
  const productsView = listView({
    loading: products.loading,
    error: products.error,
    count: options.length,
  });
  const footer = product ? (
    member ? (
      <Button busy={checkout.busy} onPress={() => checkout.start({ productId: product.id, legs })}>
        {checkout.busy ? 'Opening payment' : 'Continue to payment'}
      </Button>
    ) : (
      <Button onPress={() => router.navigate('/profile')}>Save your scans to order</Button>
    )
  ) : undefined;

  return (
    <Screen onRefresh={products.reload} refreshing={products.loading} footer={footer}>
      <Heading level="display">{legs.length === 1 ? 'Your guard' : 'Your pair'}</Heading>
      <View style={{ height: spacing.sm }} />
      <Body color={colors.textSecondary}>
        {legs.length === 1 && legs[0] ? LEG_LABEL[legs[0].leg] : 'Both legs'}, printed to this scan.
      </Body>
      <View style={{ height: spacing.xl }} />

      {productsView === 'loading' && <LoadingState label="Loading guards" />}
      {productsView === 'error' && (
        <ErrorState
          title="Guards did not load."
          line="Check your connection."
          onRetry={products.reload}
        />
      )}
      {productsView === 'empty' && <EmptyState title="Nothing on sale right now" />}
      <View accessibilityRole="radiogroup" style={styles.options}>
        {options.map((option) => {
          const selected = option.id === product?.id;
          return (
            <Pressable
              key={option.id}
              onPress={() => setPickedId(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && !selected && styles.optionPressed,
              ]}
            >
              <View style={styles.optionHeader}>
                {/* Shape, not only border color, marks the pick. */}
                <Feather
                  name={selected ? 'check-square' : 'square'}
                  size={22}
                  color={colors.textPrimary}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
                <Text
                  maxFontSizeMultiplier={maxFontScale.h3}
                  style={[typography.h3, styles.optionName]}
                >
                  {option.name}
                </Text>
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
          <View style={styles.totalRow} accessible>
            <Body color={colors.textSecondary}>
              {legs.length === 1 ? 'Total, one guard' : 'Total, two guards'}
            </Body>
            <Text maxFontSizeMultiplier={maxFontScale.h2} style={[typography.h2, styles.amount]}>
              {formatMoney(orderTotalCents(product.priceCents, legs.length), product.currency)}
            </Text>
          </View>
          <Body variant="caption" color={colors.textSecondary}>
            {member ? 'Secure payment with Stripe.' : 'Ordering needs an account.'}
          </Body>
          {/* TODO(liam): a buyer paying for a custom item expects delivery time and
              the remake or returns policy here, before payment. Neither is
              decided, so nothing is shown; add one line each once they are. */}
          {member && checkout.error && (
            <View accessibilityLiveRegion="polite" role="alert">
              <Body color={colors.danger}>{checkoutErrorMessage(checkout.error)}</Body>
            </View>
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
    minHeight: sizing.control,
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
    alignItems: 'center',
    gap: spacing.md,
  },
  optionPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  optionName: {
    flex: 1,
    color: colors.textPrimary,
  },
  total: {
    marginTop: spacing.xl,
    gap: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  amount: {
    color: colors.textPrimary,
  },
});
