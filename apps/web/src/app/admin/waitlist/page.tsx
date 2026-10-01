import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { requireAdmin } from '@/lib/admin-auth';
import { DEFAULT_PAGE_SIZE, firstValue, parsePageParam } from '@/lib/pagination';
import { formatDateTime } from '@/lib/view';
import { WAITLIST_INTERESTS } from '@/lib/waitlist';
import { listWaitlist, parseInterest } from '@/lib/waitlist-admin';

export const metadata: Metadata = {
  title: `Waitlist - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function href(interest: string, page = 1): string {
  const params = new URLSearchParams();
  if (interest !== 'all') {
    params.set('interest', interest);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query ? `/admin/waitlist?${query}` : '/admin/waitlist';
}

export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();

  const sp = await searchParams;
  const interest = parseInterest(firstValue(sp.interest));
  const active = interest ?? 'all';
  const page = parsePageParam(sp.page);

  const { counts, rows, hasNext } = await listWaitlist({
    actor: ctx.actor,
    interest,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const filters = ['all', ...WAITLIST_INTERESTS];

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Waitlist</h1>
          <p className={styles.subtitle}>
            {WAITLIST_INTERESTS.map((i) => `${i}: ${counts[i]}`).join(' / ')}. Each view is recorded
            in the audit log.
          </p>
        </div>
      </div>

      <nav className={styles.filterBar} aria-label="Filter by interest">
        {filters.map((value) => {
          const isActive = value === active;
          return (
            <Link
              key={value}
              href={href(value)}
              className={`${styles.filter} ${isActive ? styles.filterActive : ''}`}
              aria-current={isActive ? 'page' : undefined}
            >
              {value}
            </Link>
          );
        })}
      </nav>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Email</th>
              <th>Interest</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={3}>
                  No sign-ups{interest ? ` for "${interest}"` : ''}.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.email}</td>
                  <td className={styles.mono}>{row.interest}</td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(row.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.pager}>
        <Link
          href={href(active, Math.max(1, page - 1))}
          className={`${styles.pageBtn} ${page <= 1 ? styles.pageBtnDisabled : ''}`}
          aria-disabled={page <= 1}
        >
          Previous
        </Link>
        <span>Page {page}</span>
        <Link
          href={href(active, page + 1)}
          className={`${styles.pageBtn} ${hasNext ? '' : styles.pageBtnDisabled}`}
          aria-disabled={!hasNext}
        >
          Next
        </Link>
      </div>
    </AdminShell>
  );
}
