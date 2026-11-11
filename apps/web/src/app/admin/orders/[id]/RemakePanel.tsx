'use client';

import { useEffect, useRef, useState } from 'react';

import { remakeOrder } from '../../actions';
import styles from '../../admin.module.css';
import { SubmitButton } from '../../SubmitButton';
import {
  MAX_REMAKE_NOTE,
  REMAKE_REASONS,
  REMAKE_REASON_LABEL,
  isFitReason,
  isRemakeReason,
  type RemakeLegs,
} from '@/lib/remake';

const LEG_LABEL: Record<RemakeLegs, string> = {
  both: 'Every leg on the order',
  left: 'Left leg only',
  right: 'Right leg only',
};

/**
 * Two-step remake: reason, legs and note, then confirm. create_order_remake
 * repeats every check server-side and returns the open remake on a repeat.
 */
export function RemakePanel({
  orderId,
  reference,
  legOptions,
}: {
  orderId: string;
  reference: string;
  legOptions: RemakeLegs[];
}) {
  const [reason, setReason] = useState('');
  const [legs, setLegs] = useState<RemakeLegs>('both');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.querySelector('button')?.focus();
    }
  }, [confirming]);

  function review() {
    if (!isRemakeReason(reason)) {
      setError('Choose a reason for the remake.');
      return;
    }
    if (reason === 'other' && !note.trim()) {
      setError('Describe the reason when it is Other.');
      return;
    }
    setError(null);
    setConfirming(true);
  }

  if (confirming && isRemakeReason(reason)) {
    return (
      <form action={remakeOrder} className={styles.form}>
        <input type="hidden" name="id" value={orderId} />
        <input type="hidden" name="reason" value={reason} />
        <input type="hidden" name="legs" value={legs} />
        <input type="hidden" name="note" value={note.trim()} />
        <p className={styles.actionNote} role="status">
          Create a free remake of order {reference} ({REMAKE_REASON_LABEL[reason].toLowerCase()},{' '}
          {LEG_LABEL[legs].toLowerCase()}). It is a new paid order at no cost, its CAD jobs start
          right away, and the customer is emailed.
        </p>
        <div className={styles.actionBar} ref={confirmRef}>
          <SubmitButton pendingLabel="Creating remake">Confirm remake</SubmitButton>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => setConfirming(false)}
          >
            Back
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.form}>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Reason</span>
          <select
            className={styles.input}
            name="remake-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Choose a reason</option>
            {REMAKE_REASONS.map((value) => (
              <option key={value} value={value}>
                {REMAKE_REASON_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        {legOptions.length > 1 ? (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Legs</span>
            <select
              className={styles.input}
              name="remake-legs"
              value={legs}
              onChange={(e) => setLegs(e.target.value as RemakeLegs)}
            >
              {legOptions.map((value) => (
                <option key={value} value={value}>
                  {LEG_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Note</span>
        <textarea
          className={styles.input}
          name="remake-note"
          rows={3}
          maxLength={MAX_REMAKE_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby="remake-note-hint"
        />
        <span className={styles.fieldHint} id="remake-note-hint">
          Internal, never shown to the customer. Required for Other. At most {MAX_REMAKE_NOTE}{' '}
          characters.
        </span>
      </label>
      {isRemakeReason(reason) && isFitReason(reason) ? (
        <p className={styles.actionNote}>
          The remake reuses the original scans and measurements. If the fit was off because of the
          scan, the new guard may fit the same way.
        </p>
      ) : null}
      <div className={styles.actionBar}>
        <button type="button" className={styles.secondaryBtn} onClick={review}>
          Review remake
        </button>
      </div>
    </div>
  );
}
