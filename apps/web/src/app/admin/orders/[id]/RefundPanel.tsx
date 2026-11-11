'use client';

import { useEffect, useRef, useState } from 'react';

import { refundOrder } from '../../actions';
import styles from '../../admin.module.css';
import { SubmitButton } from '../../SubmitButton';
import { formatMoney, parseMoneyAmount } from '@/lib/money';

/**
 * Two-step refund: choose full or partial and review, then confirm. The
 * checks here only help the admin; refundOrderAction repeats every one
 * server-side against the ledger and Stripe.
 */
export function RefundPanel({
  orderId,
  currency,
  remainingCents,
  fullCancels,
}: {
  orderId: string;
  currency: string;
  remainingCents: number;
  fullCancels: boolean;
}) {
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.querySelector('button')?.focus();
    }
  }, [confirming]);

  const cents = mode === 'full' ? remainingCents : parseMoneyAmount(amount);

  function review() {
    if (mode === 'partial' && (cents === null || cents < 1 || cents > remainingCents)) {
      setError(
        `Enter an amount from ${formatMoney(1, currency)} to ${formatMoney(remainingCents, currency)}.`,
      );
      return;
    }
    setError(null);
    setConfirming(true);
  }

  if (confirming && cents !== null) {
    return (
      <form action={refundOrder} className={styles.form}>
        <input type="hidden" name="id" value={orderId} />
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="amount" value={mode === 'partial' ? amount.trim() : ''} />
        <p className={styles.actionNote} role="status">
          Refund {formatMoney(cents, currency)} to the customer through Stripe. This cannot be
          undone.
          {mode === 'full' && fullCancels ? ' The order will also be cancelled.' : ''}
        </p>
        <div className={styles.actionBar} ref={confirmRef}>
          <SubmitButton pendingLabel="Refunding">
            Confirm refund of {formatMoney(cents, currency)}
          </SubmitButton>
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
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>Refund type</legend>
        <label className={styles.checkboxField}>
          <input
            type="radio"
            name="refund-mode"
            value="full"
            checked={mode === 'full'}
            onChange={() => setMode('full')}
          />
          Full: the remaining {formatMoney(remainingCents, currency)}
        </label>
        <label className={styles.checkboxField}>
          <input
            type="radio"
            name="refund-mode"
            value="partial"
            checked={mode === 'partial'}
            onChange={() => setMode('partial')}
          />
          Partial
        </label>
      </fieldset>
      {mode === 'partial' ? (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Amount ({currency.toUpperCase()})</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="refund-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="12.50"
            maxLength={11}
            aria-describedby="refund-amount-hint"
          />
          <span className={styles.fieldHint} id="refund-amount-hint">
            At most {formatMoney(remainingCents, currency)}. A partial refund leaves the status as
            it is.
          </span>
        </label>
      ) : null}
      <div className={styles.actionBar}>
        <button type="button" className={styles.secondaryBtn} onClick={review}>
          Review refund
        </button>
      </div>
    </div>
  );
}
