import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { Pager } from '../Pager';
import { StatusBadge } from '../StatusBadge';
import queueStyles from './print-queue.module.css';
import { requireAdmin } from '@/lib/admin-auth';
import { listPrintQueue } from '@/lib/data';
import { DEFAULT_PAGE_SIZE, parsePageParam } from '@/lib/pagination';
import { clampQueuePage, shapeQueueRow } from '@/lib/print-queue';
import { remakeReasonLabel } from '@/lib/remake';
import { formatDateTime } from '@/lib/view';

export const metadata: Metadata = {
  title: `Print queue - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function pageHref(page: number): string {
  return page > 1 ? `/admin/print-queue?page=${page}` : '/admin/print-queue';
}

export default async function PrintQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const page = clampQueuePage(parsePageParam(sp.page));

  const { rows, hasNext } = await listPrintQueue({ page, pageSize: DEFAULT_PAGE_SIZE });
  const now = Date.now();
  const queue = rows.map((entry) => shapeQueueRow(entry, now));

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Print queue</h1>
          <p className={styles.subtitle}>
            Paid and in production orders, oldest payment first. Read-only: change an order&apos;s
            status on its own page.
          </p>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>Orders waiting to be printed, oldest first</caption>
          <thead>
            <tr>
              <th>Order</th>
              <th>Product</th>
              <th>Status</th>
              <th>Legs, CAD job and STL</th>
              <th>Since payment</th>
              <th>Paid</th>
              <th>Slip</th>
            </tr>
          </thead>
          <tbody>
            {queue.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={7}>
                  {page > 1 ? 'No orders on this page.' : 'Nothing waiting to be printed.'}
                </td>
              </tr>
            ) : (
              queue.map((row) => (
                <tr key={row.id}>
                  <td className={`${styles.idCell} ${styles.mono}`}>
                    <Link href={`/admin/orders/${row.id}`} className={styles.idLink}>
                      {row.reference}
                    </Link>
                    {row.isRemake ? (
                      <>
                        {' '}
                        <span className={queueStyles.remakeMark}>Remake</span>
                        {row.remakeReason ? (
                          <span className={styles.muted}>
                            {' '}
                            {remakeReasonLabel(row.remakeReason)}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </td>
                  <td>{row.product}</td>
                  <td>
                    <StatusBadge status={row.status} kind="order" />
                  </td>
                  <td>
                    {row.legs.length === 0 ? (
                      <span className={styles.muted}>No legs on this order</span>
                    ) : (
                      <ul className={queueStyles.legList}>
                        {row.legs.map((leg) => (
                          <li key={leg.side} className={queueStyles.leg}>
                            <span className={queueStyles.legSide}>{leg.side}</span>
                            <span className={queueStyles.legState}>{leg.state}</span>
                            {leg.stlHref ? (
                              <a
                                href={leg.stlHref}
                                className={styles.secondaryBtn}
                                aria-label={`Download ${leg.side.toLowerCase()} leg STL for order ${row.reference}`}
                              >
                                Download STL
                              </a>
                            ) : (
                              <span className={styles.muted}>No STL yet</span>
                            )}
                            {leg.jobId ? (
                              <Link href={`/admin/jobs/${leg.jobId}`} className={styles.idLink}>
                                Job
                              </Link>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={styles.mono}>{row.age}</td>
                  <td className={`${styles.mono} ${styles.muted}`}>{formatDateTime(row.paidAt)}</td>
                  <td>
                    <Link
                      href={`/admin/orders/${row.id}/packing-slip`}
                      className={styles.secondaryBtn}
                      aria-label={`Packing slip for order ${row.reference}`}
                    >
                      Packing slip
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pager
        page={page}
        prevHref={page <= 1 ? null : pageHref(page - 1)}
        nextHref={hasNext ? pageHref(page + 1) : null}
      />
    </AdminShell>
  );
}
