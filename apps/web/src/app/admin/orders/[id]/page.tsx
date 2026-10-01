import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import { refundOrder, saveTracking, setOrderStatus } from '../../actions';
import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { StatusBadge } from '../../StatusBadge';
import { requireAdmin } from '@/lib/admin-auth';
import { getOrderDetail } from '@/lib/data';
import { firstValue } from '@/lib/pagination';
import { canRefund } from '@/lib/refund';
import {
  ORDER_ACTION_LABEL,
  describeAudit,
  formatAddress,
  formatMoney,
  nextOrderStatuses,
} from '@/lib/shop';
import { formatDateTime, shortId } from '@/lib/view';

export const metadata: Metadata = {
  title: `Order - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const { id } = await params;
  const error = firstValue((await searchParams).error);

  const order = await getOrderDetail(id);
  if (!order) {
    notFound();
  }

  const moves = nextOrderStatuses(order.status);
  const address = formatAddress(order.address);

  return (
    <AdminShell fake={ctx.fake}>
      <Link href="/admin/orders" className={styles.backLink}>
        Back to orders
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.detailHead}>
          <h1 className={`${styles.title} ${styles.mono}`}>{shortId(order.id)}</h1>
          <StatusBadge status={order.status} kind="order" />
        </div>
      </div>

      {error ? <p className={styles.formError}>{error}</p> : null}

      <div className={styles.factGrid}>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Product</div>
          <div className={styles.factValue}>{order.product_name ?? 'unknown'}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Amount</div>
          <div className={styles.factValue}>{formatMoney(order.amount_cents, order.currency)}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Customer</div>
          <div className={styles.factValue}>{order.customer_email ?? shortId(order.user_id)}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Placed</div>
          <div className={styles.factValue}>{formatDateTime(order.created_at)}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Paid</div>
          <div className={styles.factValue}>
            {order.paid_at ? formatDateTime(order.paid_at) : '-'}
          </div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Stripe payment</div>
          <div className={`${styles.factValue} ${styles.mono}`}>
            {order.stripe_payment_intent ?? '-'}
          </div>
        </div>
        {order.refunded_at ? (
          <div className={styles.fact}>
            <div className={styles.factTerm}>Refunded</div>
            <div className={styles.factValue}>{formatDateTime(order.refunded_at)}</div>
          </div>
        ) : null}
        <div className={styles.fact}>
          <div className={styles.factTerm}>Left leg scan</div>
          <div className={`${styles.factValue} ${styles.mono}`}>
            {order.scan_id_left ? shortId(order.scan_id_left) : '-'}
          </div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Right leg scan</div>
          <div className={`${styles.factValue} ${styles.mono}`}>
            {order.scan_id_right ? shortId(order.scan_id_right) : '-'}
          </div>
        </div>
      </div>

      <h2 className={styles.sectionLabel}>Status</h2>
      {moves.length === 0 ? (
        <p className={styles.actionNote}>This order is closed. No further moves.</p>
      ) : (
        <div className={styles.actionBar}>
          {moves.map((to) => (
            <form key={to} action={setOrderStatus} className={styles.inlineForm}>
              <input type="hidden" name="id" value={order.id} />
              <input type="hidden" name="to" value={to} />
              <button
                type="submit"
                className={to === 'cancelled' ? styles.secondaryBtn : styles.downloadBtn}
              >
                {ORDER_ACTION_LABEL[to]}
              </button>
            </form>
          ))}
          {moves.includes('cancelled') && order.status !== 'pending_payment' ? (
            <span className={styles.actionNote}>
              Cancelling does not refund. Issue the refund in Stripe as well.
            </span>
          ) : null}
        </div>
      )}

      {canRefund(order) ? (
        <>
          <h2 className={styles.sectionLabel}>Payment</h2>
          <form action={refundOrder} className={styles.actionBar}>
            <input type="hidden" name="id" value={order.id} />
            <button type="submit" className={styles.secondaryBtn}>
              Refund payment
            </button>
            <span className={styles.actionNote}>
              Full refund through Stripe. Paid or in-production orders are also cancelled.
            </span>
          </form>
        </>
      ) : null}

      <h2 className={styles.sectionLabel}>Shipping</h2>
      <form action={saveTracking} className={styles.form}>
        <input type="hidden" name="id" value={order.id} />
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Carrier</span>
            <input
              className={styles.input}
              name="tracking_carrier"
              defaultValue={order.tracking_carrier ?? ''}
              placeholder="UPS"
              maxLength={40}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Tracking number</span>
            <input
              className={`${styles.input} ${styles.mono}`}
              name="tracking_number"
              defaultValue={order.tracking_number ?? ''}
              maxLength={40}
            />
          </label>
        </div>
        <div className={styles.actionBar}>
          <button type="submit" className={styles.secondaryBtn}>
            Save tracking
          </button>
          <span className={styles.actionNote}>
            The customer sees this in the app. Required before marking shipped.
          </span>
        </div>
      </form>
      <h2 className={styles.sectionLabel}>Ship to</h2>
      {address ? (
        <p className={styles.addressBlock}>{address}</p>
      ) : (
        <p className={styles.actionNote}>No address on this order yet.</p>
      )}

      <h2 className={styles.sectionLabel}>Pipeline jobs</h2>
      {order.jobs.length === 0 ? (
        <p className={styles.actionNote}>No pipeline jobs linked to this order.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Job</th>
                <th>Scan</th>
                <th>Step</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {order.jobs.map((job) => (
                <tr key={job.id}>
                  <td className={`${styles.idCell} ${styles.mono}`}>
                    <Link href={`/admin/jobs/${job.id}`} className={styles.idLink}>
                      {shortId(job.id)}
                    </Link>
                  </td>
                  <td className={styles.mono}>{shortId(job.scan_id)}</td>
                  <td>{job.step}</td>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className={styles.sectionLabel}>History</h2>
      {order.history.length === 0 ? (
        <p className={styles.actionNote}>No recorded changes.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Change</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {order.history.map((row) => (
                <tr key={row.id}>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(row.created_at)}
                  </td>
                  <td>{describeAudit(row)}</td>
                  <td className={styles.muted}>{row.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
