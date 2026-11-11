import styles from '../admin.module.css';

/** Shown while a customer search runs. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <p className={styles.actionNote} role="status">
        Searching customers.
      </p>
    </main>
  );
}
