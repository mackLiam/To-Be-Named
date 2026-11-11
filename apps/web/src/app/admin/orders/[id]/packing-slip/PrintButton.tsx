'use client';

import styles from './packing-slip.module.css';

/** Opens the browser print dialog; the print stylesheet hides everything but the slip. */
export function PrintButton() {
  return (
    <button type="button" className={styles.printBtn} onClick={() => window.print()}>
      Print slip
    </button>
  );
}
