import styles from './spinner.module.css';

/** Decorative: the label next to it says what is happening. */
export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}
