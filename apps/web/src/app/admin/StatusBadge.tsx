import styles from './admin.module.css';
import { jobStatusMeta, type StatusTone } from '@/lib/view';

const TONE_CLASS: Record<StatusTone, string | undefined> = {
  neutral: styles.toneNeutral,
  progress: styles.toneProgress,
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
};

/**
 * Small rectangular text badge for a queue status. Never a pill; tone maps to
 * navy/orange/danger fills whose text contrast is fixed in the CSS.
 */
export function StatusBadge({ status }: { status: string }) {
  const meta = jobStatusMeta(status);
  return <span className={`${styles.badge} ${TONE_CLASS[meta.tone]}`}>{meta.label}</span>;
}
