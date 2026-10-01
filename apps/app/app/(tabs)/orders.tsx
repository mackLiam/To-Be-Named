import type { OrderStatus } from '@forms/shared';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useOrders } from '../../src/hooks/useOrders';
import { formatMoney } from '../../src/lib/checkout';
import { colors, spacing } from '../../src/theme/tokens';

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Payment pending',
  paid: 'Paid, queued for production',
  in_production: 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export default function OrdersScreen() {
  const { data: orders, loading, error, reload } = useOrders();
  // The first focus is the mount, which already fetches; later focuses
  // (back from the Stripe page in the browser) refetch.
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) {
        reload();
      }
      focusedBefore.current = true;
    }, [reload]),
  );

  return (
    <Screen>
      <Heading level="display">Order status.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        Every order, from payment to shipped. No account portal to dig through, it is all on this
        screen.
      </Body>
      <Rule />

      {loading && <Body color={colors.textSecondary}>Loading your orders.</Body>}

      {error && (
        <Body color={colors.danger}>Could not load your orders right now. Try again shortly.</Body>
      )}

      {!loading && !error && orders.length === 0 && (
        <View>
          <Heading level="h3">No orders yet.</Heading>
          <View style={{ height: spacing.sm }} />
          <Body color={colors.textSecondary}>
            Scan your leg and order from the Shop tab. This tab tracks it from payment through
            delivery.
          </Body>
        </View>
      )}

      {orders.map((order) => (
        <View key={order.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body variant="bodyStrong">{order.productName}</Body>
            {order.totalCents !== null && (
              <Body>{formatMoney(order.totalCents, order.currency)}</Body>
            )}
          </View>
          <Body color={colors.textSecondary} variant="bodySmall">
            {STATUS_LABEL[order.status]}
          </Body>
          {order.trackingNumber && (
            <Body color={colors.textSecondary} variant="bodySmall">
              Tracking: {order.trackingCarrier ? `${order.trackingCarrier} ` : ''}
              {order.trackingNumber}
            </Body>
          )}
          <Rule />
        </View>
      ))}
    </Screen>
  );
}
