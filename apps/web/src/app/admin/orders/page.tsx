import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ORDER_STATUSES } from '@forms/shared';
import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { StatusBadge } from '../StatusBadge';
import { requireAdmin } from '@/lib/admin-auth';
import { listOrders } from '@/lib/data';
import { DEFAULT_PAGE_SIZE, firstValue, parsePageParam } from '@/lib/pagination';
import { ORDER_STATUS_META, formatMoney, isOrderStatus, orderReferenceRange } from '@/lib/shop';
import { formatDateTime, shortId } from '@/lib/view';

export const metadata: Metadata = {
  title: `Orders - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function href(status: string, page = 1): string {
  const params = new URLSearchParams();
  if (status !== 'all') {
    params.set('status', status);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query ? `/admin/orders?${query}` : '/admin/orders';
}

function legs(left: string | null, right: string | null): string {
  return [left && 'L', right && 'R'].filter(Boolean).join(' + ') || '-';
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();

  const sp = await searchParams;
  const rawStatus = firstValue(sp.status);
  const activeStatus = isOrderStatus(rawStatus) ? rawStatus : 'all';
  const page = parsePageParam(sp.page);
  const rawRef = firstValue(sp.ref)?.trim() ?? '';
  const ref = orderReferenceRange(rawRef) ? rawRef : undefined;

  const { rows, hasNext } = await listOrders({
    status: activeStatus === 'all' ? undefined : activeStatus,
    ref,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  // A reference names one order in practice; go straight to it.
  if (ref && rows.length === 1 && page === 1) {
    redirect(`/admin/orders/${rows[0]!.id}`);
  }

  const filters = [
    { value: 'all', label: 'All' },
    ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_META[s].label })),
  ];

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Orders</h1>
          <p className={styles.subtitle}>
            Newest first. Paid orders are waiting on you to start production.
          </p>
        </div>
      </div>

      <form method="get" action="/admin/orders" className={styles.filterBar}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Order reference</span>
          <input
            className={styles.input}
            name="ref"
            defaultValue={rawRef}
            placeholder="ABCDEF12"
            maxLength={9}
            autoComplete="off"
          />
        </label>
        <button type="submit" className={styles.downloadBtn}>
          Find
        </button>
        {rawRef && !ref ? (
          <span className={styles.formError}>A reference is the 8 characters from the email.</span>
        ) : null}
      </form>

      <nav className={styles.filterBar} aria-label="Filter by status">
        {filters.map((filter) => {
          const isActive = filter.value === activeStatus;
          return (
            <Link
              key={filter.value}
              href={href(filter.value)}
              className={`${styles.filter} ${isActive ? styles.filterActive : ''}`}
              aria-current={isActive ? 'page' : undefined}
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order</th>
              <th>Product</th>
              <th>Legs</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Tracking</th>
              <th>Placed</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={8}>
                  No orders
                  {activeStatus === 'all'
                    ? ''
                    : ` that are ${ORDER_STATUS_META[activeStatus].label.toLowerCase()}`}
                  .
                </td>
              </tr>
            ) : (
              rows.map((order) => (
                <tr key={order.id}>
                  <td className={`${styles.idCell} ${styles.mono}`}>
                    <Link href={`/admin/orders/${order.id}`} className={styles.idLink}>
                      {shortId(order.id)}
                    </Link>
                  </td>
                  <td>{order.product_name ?? <span className={styles.muted}>unknown</span>}</td>
                  <td className={styles.mono}>{legs(order.scan_id_left, order.scan_id_right)}</td>
                  <td className={styles.mono}>{formatMoney(order.amount_cents, order.currency)}</td>
                  <td>
                    <StatusBadge status={order.status} kind="order" />
                  </td>
                  <td className={styles.mono}>
                    {order.tracking_number ?? <span className={styles.muted}>-</span>}
                  </td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(order.created_at)}
                  </td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(order.updated_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.pager}>
        <Link
          href={href(activeStatus, Math.max(1, page - 1))}
          className={`${styles.pageBtn} ${page <= 1 ? styles.pageBtnDisabled : ''}`}
          aria-disabled={page <= 1}
        >
          Previous
        </Link>
        <span>Page {page}</span>
        <Link
          href={href(activeStatus, page + 1)}
          className={`${styles.pageBtn} ${hasNext ? '' : styles.pageBtnDisabled}`}
          aria-disabled={!hasNext}
        >
          Next
        </Link>
      </div>
    </AdminShell>
  );
}
