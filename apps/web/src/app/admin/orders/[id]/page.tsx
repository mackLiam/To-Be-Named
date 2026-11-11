import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import { addOrderNote, saveTracking, setOrderStatus } from '../../actions';
import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { Pager } from '../../Pager';
import { StatusBadge } from '../../StatusBadge';
import { SubmitButton } from '../../SubmitButton';
import { RefundPanel } from './RefundPanel';
import { RemakePanel } from './RemakePanel';
import { requireAdmin } from '@/lib/admin-auth';
import { adminErrorText, adminNoticeText } from '@/lib/admin-messages';
import { getOrderDetail, getOrderTimeline } from '@/lib/data';
import { MAX_NOTE_LENGTH } from '@/lib/order-notes';
import { DEFAULT_PAGE_SIZE, firstValue, parsePageParam } from '@/lib/pagination';
import { refundPanelState } from '@/lib/refund';
import { remakeLegOptions, remakeReasonLabel, remakeState } from '@/lib/remake';
import {
  ORDER_ACTION_LABEL,
  customerLabel,
  formatAddress,
  formatMoney,
  nextOrderStatuses,
} from '@/lib/shop';
import { TIMELINE_KIND_LABEL, toTimeline } from '@/lib/timeline';
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
  const sp = await searchParams;
  const error = adminErrorText(firstValue(sp.error));
  const notice = error ? null : adminNoticeText(firstValue(sp.notice));
  const timelinePage = parsePageParam(sp.tl);

  const order = await getOrderDetail(id);
  if (!order) {
    notFound();
  }
  const timeline = await getOrderTimeline(order.id, timelinePage, DEFAULT_PAGE_SIZE);
  const entries = timeline.rows ? toTimeline(timeline.rows, order.currency) : null;

  const moves = nextOrderStatuses(order.status);
  const address = formatAddress(order.address);
  const refundState = refundPanelState(order, order.refunds);
  const remake = remakeState(order);
  const currency = order.currency ?? 'usd';
  const reference = shortId(order.id).toUpperCase();
  const timelineHref = (page: number) =>
    page > 1
      ? `/admin/orders/${order.id}?tl=${page}#timeline`
      : `/admin/orders/${order.id}#timeline`;

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
        <Link href={`/admin/orders/${order.id}/packing-slip`} className={styles.secondaryBtn}>
          Packing slip
        </Link>
      </div>

      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

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
          <div className={styles.factValue}>{customerLabel(order)}</div>
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
        {refundState.refundedCents > 0 ? (
          <div className={styles.fact}>
            <div className={styles.factTerm}>Refunded so far</div>
            <div className={styles.factValue}>
              {formatMoney(refundState.refundedCents, order.currency)}
            </div>
          </div>
        ) : null}
        {order.remake_of ? (
          <div className={styles.fact}>
            <div className={styles.factTerm}>Remake of</div>
            <div className={`${styles.factValue} ${styles.mono}`}>
              <Link href={`/admin/orders/${order.remake_of}`} className={styles.idLink}>
                {shortId(order.remake_of)}
              </Link>{' '}
              <span className={styles.muted}>({remakeReasonLabel(order.remake_reason)})</span>
            </div>
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
              <SubmitButton
                pendingLabel="Saving"
                variant={to === 'cancelled' ? 'secondary' : 'primary'}
              >
                {ORDER_ACTION_LABEL[to]}
              </SubmitButton>
            </form>
          ))}
          {moves.includes('cancelled') && order.status !== 'pending_payment' ? (
            <span className={styles.actionNote}>
              Cancelling does not refund. Use Refund payment below for a Stripe payment, or refund
              it by hand if it was marked paid manually.
            </span>
          ) : null}
        </div>
      )}

      <h2 className={styles.sectionLabel}>Payment</h2>
      {refundState.offer ? (
        <RefundPanel
          orderId={order.id}
          currency={currency}
          remainingCents={refundState.remainingCents}
          fullCancels={refundState.fullCancels}
        />
      ) : (
        <p className={styles.actionNote}>
          {order.stripe_payment_intent
            ? 'Nothing to refund from the panel. Delivered or fully refunded orders are handled in the Stripe dashboard.'
            : 'No Stripe payment on this order.'}
        </p>
      )}
      {order.refunds.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Refunds issued from the panel</caption>
            <thead>
              <tr>
                <th>#</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Stripe</th>
                <th>When</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {order.refunds.map((refund) => (
                <tr key={refund.id}>
                  <td className={styles.mono}>{refund.seq}</td>
                  <td>{refund.kind}</td>
                  <td className={styles.mono}>
                    {formatMoney(refund.amount_cents, order.currency)}
                  </td>
                  <td className={styles.mono}>
                    {refund.stripe_refund_id}
                    {refund.stripe_status ? (
                      <span className={styles.muted}> ({refund.stripe_status})</span>
                    ) : null}
                  </td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(refund.created_at)}
                  </td>
                  <td className={styles.muted}>{refund.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2 className={styles.sectionLabel}>Remake</h2>
      {order.remakes.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Remakes of this order</caption>
            <thead>
              <tr>
                <th>Remake</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {order.remakes.map((child) => (
                <tr key={child.id}>
                  <td className={`${styles.idCell} ${styles.mono}`}>
                    <Link href={`/admin/orders/${child.id}`} className={styles.idLink}>
                      {shortId(child.id)}
                    </Link>
                  </td>
                  <td>{remakeReasonLabel(child.remake_reason)}</td>
                  <td>
                    <StatusBadge status={child.status} kind="order" />
                  </td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(child.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {remake.kind === 'offer' ? (
        <RemakePanel
          orderId={order.id}
          reference={reference}
          legOptions={remakeLegOptions(order)}
        />
      ) : remake.kind === 'open' ? (
        <p className={styles.actionNote}>
          An open remake exists:{' '}
          <Link href={`/admin/orders/${remake.remakeId}`} className={styles.idLink}>
            {shortId(remake.remakeId)}
          </Link>
          . Cancel it first to start another.
        </p>
      ) : (
        <p className={styles.actionNote}>{remake.reason}</p>
      )}

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
          <SubmitButton pendingLabel="Saving tracking" variant="secondary">
            Save tracking
          </SubmitButton>
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

      <h2 className={styles.sectionLabel}>Notes</h2>
      <form action={addOrderNote} className={styles.form}>
        <input type="hidden" name="id" value={order.id} />
        <input type="hidden" name="request_id" value={randomUUID()} />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Add a note</span>
          <textarea
            className={styles.input}
            name="body"
            rows={3}
            required
            maxLength={MAX_NOTE_LENGTH}
            aria-describedby="note-hint"
          />
          <span className={styles.fieldHint} id="note-hint">
            Internal, never shown to the customer. Notes cannot be edited or deleted. At most{' '}
            {MAX_NOTE_LENGTH} characters.
          </span>
        </label>
        <div className={styles.actionBar}>
          <SubmitButton pendingLabel="Saving note" variant="secondary">
            Add note
          </SubmitButton>
        </div>
      </form>

      <h2 className={styles.sectionLabel} id="timeline">
        Timeline
      </h2>
      {entries === null ? (
        <div className={styles.errorState} role="alert">
          <p className={styles.formError}>
            The timeline failed to load. The audit log has the same rows.
          </p>
          <Link href={timelineHref(timelinePage)} className={styles.secondaryBtn}>
            Try again
          </Link>
        </div>
      ) : entries.length === 0 ? (
        <p className={styles.actionNote}>
          {timelinePage > 1 ? 'No older entries.' : 'No recorded changes or notes yet.'}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Order timeline, newest first</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>What</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key}>
                  <td className={`${styles.mono} ${styles.muted}`}>{formatDateTime(entry.at)}</td>
                  <td>{TIMELINE_KIND_LABEL[entry.kind]}</td>
                  <td>
                    {entry.body !== null ? (
                      <span className={styles.noteBody}>{entry.body}</span>
                    ) : (
                      entry.text
                    )}
                    {entry.orderLink ? (
                      <>
                        {' '}
                        <Link
                          href={`/admin/orders/${entry.orderLink}`}
                          className={`${styles.idLink} ${styles.mono}`}
                        >
                          {shortId(entry.orderLink)}
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td className={styles.muted}>{entry.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries !== null && (timelinePage > 1 || timeline.hasNext) ? (
        <Pager
          page={timelinePage}
          prevHref={timelinePage <= 1 ? null : timelineHref(Math.max(1, timelinePage - 1))}
          nextHref={timeline.hasNext ? timelineHref(timelinePage + 1) : null}
          prevLabel="Newer"
          nextLabel="Older"
          label="Timeline pages"
        />
      ) : null}
    </AdminShell>
  );
}
