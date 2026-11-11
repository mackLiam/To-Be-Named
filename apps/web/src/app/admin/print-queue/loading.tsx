import { Spinner } from '../../Spinner';
import styles from '../admin.module.css';

/** Shown while the print queue loads. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <p className={styles.loadingNote} role="status">
        <Spinner />
        Loading print queue.
      </p>
    </main>
  );
}
