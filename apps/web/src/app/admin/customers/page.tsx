import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { requireAdmin } from '@/lib/admin-auth';
import { accountStateLabel, parseCustomerQuery, scanSummary } from '@/lib/customers';
import { searchCustomers } from '@/lib/data';
import { DEFAULT_PAGE_SIZE, firstValue, parsePageParam } from '@/lib/pagination';
import { formatDateTime } from '@/lib/view';

export const metadata: Metadata = {
  title: `Customers - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function href(email: string, exact: boolean, page: number): string {
  const params = new URLSearchParams({ email });
  if (exact) {
    params.set('match', 'exact');
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  return `/admin/customers?${params.toString()}`;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const rawEmail = firstValue(sp.email) ?? '';
  const rawMatch = firstValue(sp.match);
  const query = parseCustomerQuery(rawEmail, rawMatch);
  const page = parsePageParam(sp.page);

  const result =
    query.kind === 'search'
      ? await searchCustomers({
          email: query.email,
          exact: query.exact,
          page,
          pageSize: DEFAULT_PAGE_SIZE,
        })
      : null;

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Customers</h1>
          <p className={styles.subtitle}>
            Find an account by email. Deleted accounts have no email left; find their orders by
            order reference on the Orders page.
          </p>
        </div>
      </div>

      <form method="get" action="/admin/customers" className={styles.filterBar} role="search">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email</span>
          <input
            className={styles.input}
            type="search"
            name="email"
            defaultValue={rawEmail}
            placeholder="name@example.com"
            maxLength={320}
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Match</span>
          <select
            className={styles.input}
            name="match"
            defaultValue={rawMatch === 'exact' ? 'exact' : 'prefix'}
          >
            <option value="prefix">Starts with</option>
            <option value="exact">Exact</option>
          </select>
        </label>
        <button type="submit" className={styles.downloadBtn}>
          Search
        </button>
      </form>

      {query.kind === 'invalid' ? (
        <p className={styles.formError} role="alert">
          {query.error}
        </p>
      ) : null}

      {query.kind === 'empty' ? (
        <p className={styles.actionNote}>Type at least 3 characters of an email to search.</p>
      ) : null}

      {result ? (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Account</th>
                  <th>Joined</th>
                  <th>Orders</th>
                  <th>Open orders</th>
                  <th>Scans</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={styles.emptyRow} colSpan={6}>
                      No customer email{' '}
                      {query.kind === 'search' && query.exact ? 'is' : 'starts with'} &quot;
                      {query.kind === 'search' ? query.email : ''}&quot;.
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row) => (
                    <tr key={row.user_id}>
                      <td className={styles.mono}>{row.email}</td>
                      <td>{accountStateLabel(row)}</td>
                      <td className={`${styles.mono} ${styles.muted}`}>
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className={styles.mono}>
                        {row.order_count > 0 ? (
                          <Link
                            href={`/admin/orders?customer=${row.user_id}`}
                            className={styles.idLink}
                          >
                            {row.order_count}
                          </Link>
                        ) : (
                          0
                        )}
                      </td>
                      <td className={styles.mono}>{row.open_order_count}</td>
                      <td>
                        {row.scan_count}
                        <span className={styles.muted}> ({scanSummary(row.scan_statuses)})</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {query.kind === 'search' ? (
            <div className={styles.pager}>
              <Link
                href={href(query.email, query.exact, Math.max(1, page - 1))}
                className={`${styles.pageBtn} ${page <= 1 ? styles.pageBtnDisabled : ''}`}
                aria-disabled={page <= 1}
              >
                Previous
              </Link>
              <span>Page {page}</span>
              <Link
                href={href(query.email, query.exact, page + 1)}
                className={`${styles.pageBtn} ${result.hasNext ? '' : styles.pageBtnDisabled}`}
                aria-disabled={!result.hasNext}
              >
                Next
              </Link>
            </div>
          ) : null}
        </>
      ) : null}
    </AdminShell>
  );
}
