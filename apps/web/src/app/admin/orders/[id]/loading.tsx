import styles from '../../admin.module.css';

/** Shown while the order and its timeline load. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <p className={styles.actionNote} role="status">
        Loading order.
      </p>
    </main>
  );
}
