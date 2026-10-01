import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { requireAdmin } from '@/lib/admin-auth';
import {
  AUDIT_SUBJECT_TABLES,
  compactDetail,
  isAuditSubjectTable,
  listAuditLog,
  subjectHref,
} from '@/lib/ops';
import { DEFAULT_PAGE_SIZE, firstValue, parsePageParam } from '@/lib/pagination';
import { formatDateTime, shortId } from '@/lib/view';

export const metadata: Metadata = {
  title: `Audit log - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function href(table: string, page = 1): string {
  const params = new URLSearchParams();
  if (table !== 'all') {
    params.set('table', table);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query ? `/admin/audit?${query}` : '/admin/audit';
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const rawTable = firstValue(sp.table);
  const active = isAuditSubjectTable(rawTable) ? rawTable : 'all';
  const page = parsePageParam(sp.page);

  const { rows, hasNext } = await listAuditLog({
    table: active === 'all' ? undefined : active,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Audit log</h1>
          <p className={styles.subtitle}>Newest first. Every privileged action is recorded here.</p>
        </div>
      </div>

      <nav className={styles.filterBar} aria-label="Filter by subject">
        {['all', ...AUDIT_SUBJECT_TABLES].map((value) => (
          <Link
            key={value}
            href={href(value)}
            className={`${styles.filter} ${value === active ? styles.filterActive : ''}`}
            aria-current={value === active ? 'page' : undefined}
          >
            {value === 'all' ? 'All' : value}
          </Link>
        ))}
      </nav>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={5}>
                  No audit entries.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const link = subjectHref(row.subject_table, row.subject_id);
                return (
                  <tr key={row.id}>
                    <td className={`${styles.mono} ${styles.muted}`}>
                      {formatDateTime(row.created_at)}
                    </td>
                    <td className={styles.mono}>{row.actor}</td>
                    <td className={styles.mono}>{row.action}</td>
                    <td className={styles.mono}>
                      {row.subject_table ?? '-'}{' '}
                      {row.subject_id ? (
                        link ? (
                          <Link href={link} className={styles.idLink}>
                            {shortId(row.subject_id)}
                          </Link>
                        ) : (
                          shortId(row.subject_id)
                        )
                      ) : null}
                    </td>
                    <td className={`${styles.mono} ${styles.muted}`}>
                      {compactDetail(row.detail)}
                    </td>
                  </tr>
                );
              })
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
