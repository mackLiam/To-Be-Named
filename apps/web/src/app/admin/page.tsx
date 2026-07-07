import type { Metadata } from 'next';
import Link from 'next/link';

import styles from './admin.module.css';
import { AdminShell } from './AdminShell';
import { StatusBadge } from './StatusBadge';
import { requireAdmin } from '@/lib/admin-auth';
import { JOB_STATES, isValidJobState, listPipelineJobs } from '@/lib/data';
import { DEFAULT_PAGE_SIZE, parsePageParam } from '@/lib/pagination';
import { formatDateTime, shortId, summarizeJobError } from '@/lib/view';

export const metadata: Metadata = {
  title: 'Pipeline queue - Zells admin',
  robots: { index: false, follow: false },
};

// Always render per-request: this reads live queue state and the admin session.
export const dynamic = 'force-dynamic';

const FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'dead_letter', label: 'Dead letter' },
  { value: 'succeeded', label: 'Succeeded' },
];

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function filterHref(status: string): string {
  return status === 'all' ? '/admin' : `/admin?status=${status}`;
}

function pageHref(status: string, page: number): string {
  const params = new URLSearchParams();
  if (status !== 'all') {
    params.set('status', status);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query ? `/admin?${query}` : '/admin';
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Server-side gate first: a non-admin gets a 404 before any query runs.
  const ctx = await requireAdmin();

  const sp = await searchParams;
  const rawStatus = firstParam(sp.status);
  const activeStatus = isValidJobState(rawStatus) ? rawStatus : 'all';
  const page = parsePageParam(sp.page);

  const { rows, hasNext } = await listPipelineJobs({
    state: activeStatus === 'all' ? undefined : activeStatus,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Pipeline queue</h1>
          <p className={styles.subtitle}>
            Jobs advancing through the scan-to-print state machine. Newest first.
          </p>
        </div>
      </div>

      <nav className={styles.filterBar} aria-label="Filter by status">
        {FILTERS.map((filter) => {
          const isActive = filter.value === activeStatus;
          return (
            <Link
              key={filter.value}
              href={filterHref(filter.value)}
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
              <th>Job</th>
              <th>Scan / Order</th>
              <th>Step</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Error</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={8}>
                  No jobs
                  {activeStatus === 'all' ? '' : ` with status "${activeStatus}"`}.
                </td>
              </tr>
            ) : (
              rows.map((job) => {
                const summary = summarizeJobError(job.error);
                return (
                  <tr key={job.id}>
                    <td className={`${styles.idCell} ${styles.mono}`}>
                      <Link href={`/admin/jobs/${job.id}`} className={styles.idLink}>
                        {shortId(job.id)}
                      </Link>
                    </td>
                    <td className={styles.mono}>
                      <div>{shortId(job.scan_id)}</div>
                      <div className={styles.muted}>
                        {job.order_id ? shortId(job.order_id) : 'no order'}
                      </div>
                    </td>
                    <td>{job.step}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className={styles.mono}>
                      {job.attempts}/{job.max_attempts}
                    </td>
                    <td className={styles.errorText}>
                      {summary || <span className={styles.muted}>-</span>}
                    </td>
                    <td className={`${styles.mono} ${styles.muted}`}>
                      {formatDateTime(job.created_at)}
                    </td>
                    <td className={`${styles.mono} ${styles.muted}`}>
                      {formatDateTime(job.updated_at)}
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
          href={pageHref(activeStatus, Math.max(1, page - 1))}
          className={`${styles.pageBtn} ${page <= 1 ? styles.pageBtnDisabled : ''}`}
          aria-disabled={page <= 1}
        >
          Previous
        </Link>
        <span>Page {page}</span>
        <Link
          href={pageHref(activeStatus, page + 1)}
          className={`${styles.pageBtn} ${hasNext ? '' : styles.pageBtnDisabled}`}
          aria-disabled={!hasNext}
        >
          Next
        </Link>
      </div>
    </AdminShell>
  );
}
