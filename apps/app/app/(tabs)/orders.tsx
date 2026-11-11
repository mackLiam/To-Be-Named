import type { OrderStatus } from '@forms/shared';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Screen } from '../../src/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '../../src/components/StateView';
import { StatusLabel, type StatusTone } from '../../src/components/StatusLabel';
import { useOrders } from '../../src/hooks/useOrders';
import { formatMoney } from '../../src/lib/checkout';
import { orderReference, trackingUrl } from '../../src/lib/orders';
import { listView } from '../../src/lib/uiState';
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

  const view = listView({ loading, error, count: orders.length });

  return (
    <Screen title="Orders" onRefresh={reload} refreshing={loading && orders.length > 0}>
      {view === 'loading' && <LoadingState label="Loading your orders" />}

      {view === 'error' && (
        <ErrorState
          title="Your orders did not load."
          line="Check your connection."
          onRetry={reload}
        />
      )}

      {view === 'empty' && (
        <EmptyState
          title="No orders yet"
          line="Guards are ordered from a measured scan."
          action={
            <Button variant="outline" onPress={() => router.navigate('/')}>
              Go to your scans
            </Button>
          }
        />
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
          <Body variant="bodySmall" color={colors.textSecondary}>
            Order {orderReference(order.id)}
          </Body>
          {order.trackingNumber && (
            <Tracking carrier={order.trackingCarrier} number={order.trackingNumber} />
          )}
        </View>
      ))}
    </Screen>
  );
}

function Tracking({ carrier, number }: { carrier: string | null; number: string }) {
  const label = `${carrier ? `${carrier} ` : ''}${number}`;
  const url = trackingUrl(carrier, number);
  if (!url) {
    return (
      <Body variant="bodySmall" color={colors.textSecondary}>
        {label}
      </Body>
    );
  }
  return (
    <Button
      variant="text"
      style={styles.track}
      onPress={() => void Linking.openURL(url)}
      accessibilityLabel={`Track ${label} on the carrier's site`}
    >
      {`Track ${label}`}
    </Button>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  name: { flex: 1 },
  // Left-aligned with the lines above it, not centered across the row.
  track: { alignSelf: 'flex-start', paddingHorizontal: 0 },
});
