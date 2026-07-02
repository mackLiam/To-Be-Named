import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useOrders } from '../../src/hooks/useOrders';
import { colors, spacing } from '../../src/theme/tokens';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Payment pending',
  paid: 'Paid, queued for production',
  in_production: 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export default function OrdersScreen() {
  const { data: orders, loading, error } = useOrders();

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
            <Body>
              {(order.totalCents / 100).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
              })}
            </Body>
          </View>
          <Body color={colors.textSecondary} variant="bodySmall">
            {STATUS_LABEL[order.status] ?? order.status}
          </Body>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}
