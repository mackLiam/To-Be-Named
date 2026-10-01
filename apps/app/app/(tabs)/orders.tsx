import type { OrderStatus } from '@forms/shared';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Screen } from '../../src/components/Screen';
import { StatusLabel, type StatusTone } from '../../src/components/StatusLabel';
import { useOrders } from '../../src/hooks/useOrders';
import { formatMoney } from '../../src/lib/checkout';
import { colors, spacing } from '../../src/theme/tokens';

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Payment pending',
  paid: 'Paid',
  in_production: 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  pending_payment: 'action',
  paid: 'muted',
  in_production: 'muted',
  shipped: 'action',
  delivered: 'muted',
  cancelled: 'muted',
};

export default function OrdersScreen() {
  const router = useRouter();
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
    <Screen title="Orders" onRefresh={reload} refreshing={loading && orders.length > 0}>
      {loading && orders.length === 0 && <ActivityIndicator color={colors.textPrimary} />}

      {error && <Body color={colors.danger}>Could not load your orders. Pull down to retry.</Body>}

      {!loading && !error && orders.length === 0 && (
        <View style={styles.empty}>
          <Body color={colors.textSecondary}>No orders yet.</Body>
          <Button variant="outline" onPress={() => router.navigate('/')}>
            Go to your scans
          </Button>
        </View>
      )}

      {orders.map((order) => (
        <View key={order.id} style={styles.row}>
          <View style={styles.rowTop}>
            <Heading level="h3" style={styles.name}>
              {order.productName}
            </Heading>
            {order.totalCents !== null && (
              <Body variant="bodyStrong">{formatMoney(order.totalCents, order.currency)}</Body>
            )}
          </View>
          <StatusLabel label={STATUS_LABEL[order.status]} tone={STATUS_TONE[order.status]} />
          {order.trackingNumber && (
            <Body variant="bodySmall" color={colors.textSecondary}>
              {order.trackingCarrier ? `${order.trackingCarrier} ` : ''}
              {order.trackingNumber}
            </Body>
          )}
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { gap: spacing.lg },
  row: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  name: { flex: 1 },
});
