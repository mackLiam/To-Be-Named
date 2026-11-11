import { Spinner } from '../../Spinner';
import styles from '../admin.module.css';

/** Shown while a customer search runs. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <p className={styles.loadingNote} role="status">
        <Spinner />
        Searching customers.
      </p>
    </main>
  );
}
