import styles from './admin.module.css';
import { orderStatusMeta } from '@/lib/shop';
import { jobStatusMeta, type StatusTone } from '@/lib/view';

const TONE_CLASS: Record<StatusTone, string | undefined> = {
  neutral: styles.toneNeutral,
  progress: styles.toneProgress,
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
};

/**
 * Small rectangular text badge for a queue or order status. Never a pill; tone maps to
 * brown/brick/danger fills whose text contrast is fixed in the CSS.
 */
export function StatusBadge({ status, kind = 'job' }: { status: string; kind?: 'job' | 'order' }) {
  const meta = kind === 'order' ? orderStatusMeta(status) : jobStatusMeta(status);
  return <span className={`${styles.badge} ${TONE_CLASS[meta.tone]}`}>{meta.label}</span>;
}
