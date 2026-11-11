import { Spinner } from '../../../../Spinner';
import styles from '../../../admin.module.css';

/** Shown while the slip loads. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <p className={styles.loadingNote} role="status">
        <Spinner />
        Loading packing slip.
      </p>
    </main>
  );
}
