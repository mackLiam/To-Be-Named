import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import { PrintButton } from './PrintButton';
import styles from './packing-slip.module.css';
import { requireAdmin } from '@/lib/admin-auth';
import { getPackingSlipOrder } from '@/lib/data';
import { shapePackingSlip } from '@/lib/print-queue';

export const metadata: Metadata = {
  title: `Packing slip - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Deliberately outside AdminShell so no admin chrome can print. The slip shows
 * only the reference, ship-to, product, legs and a remake marker: no prices,
 * measurements or scan data (CLAUDE.md gotcha 5).
 */
export default async function PackingSlipPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin();
  const { id } = await params;

  const order = await getPackingSlipOrder(id);
  if (!order) {
    notFound();
  }
  const slip = shapePackingSlip(order);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Link href={`/admin/orders/${order.id}`} className={styles.back}>
          Back to order
        </Link>
        <PrintButton />
      </div>

      {ctx.fake ? (
        <p className={styles.fakeNote} role="note">
          Fake data. This slip shows placeholder values, not a real order.
        </p>
      ) : null}
      {slip.addressStatus === 'none' ? (
        <p className={styles.warn} role="alert">
          This order has no ship-to address. Do not pack it until one is on the order.
        </p>
      ) : slip.addressStatus === 'partial' ? (
        <p className={styles.warn} role="alert">
          The ship-to address is missing a street line or country. Check the order before packing.
        </p>
      ) : null}

      <article className={styles.slip} aria-label={`Packing slip for order ${slip.reference}`}>
        <header className={styles.slipHead}>
          <h1 className={styles.slipTitle}>{BRAND_NAME} packing slip</h1>
          <p className={styles.reference}>Order {slip.reference}</p>
        </header>

        <h2 className={styles.label}>Ship to</h2>
        {slip.addressLines.length > 0 ? (
          <p className={styles.address}>{slip.addressLines.join('\n')}</p>
        ) : (
          <p className={styles.value}>No address on this order.</p>
        )}

        <h2 className={styles.label}>Product</h2>
        <p className={styles.value}>{slip.product}</p>

        <h2 className={styles.label}>Legs</h2>
        <p className={styles.value}>{slip.legs}</p>

        {slip.isRemake ? <p className={styles.remake}>Remake</p> : null}
      </article>
    </div>
  );
}
