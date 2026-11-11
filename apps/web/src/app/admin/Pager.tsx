import Link from 'next/link';

import styles from './admin.module.css';

/**
 * Previous/next paging. An unavailable direction renders as inert text, not
 * a link with pointer-events off, so the keyboard cannot follow it either.
 */
export function Pager({
  prevHref,
  nextHref,
  page,
  prevLabel = 'Previous',
  nextLabel = 'Next',
  label = 'Pages',
}: {
  prevHref: string | null;
  nextHref: string | null;
  page: number;
  prevLabel?: string;
  nextLabel?: string;
  label?: string;
}) {
  return (
    <nav className={styles.pager} aria-label={label}>
      {prevHref ? (
        <Link href={prevHref} className={styles.pageBtn}>
          {prevLabel}
        </Link>
      ) : (
        <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">
          {prevLabel}
        </span>
      )}
      <span aria-current="page">Page {page}</span>
      {nextHref ? (
        <Link href={nextHref} className={styles.pageBtn}>
          {nextLabel}
        </Link>
      ) : (
        <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">
          {nextLabel}
        </span>
      )}
    </nav>
  );
}
