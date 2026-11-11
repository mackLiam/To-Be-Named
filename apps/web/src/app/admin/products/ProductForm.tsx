'use client';

import { useActionState, useState } from 'react';

import { saveProduct, type ProductFormState } from '../actions';
import styles from '../admin.module.css';
import { AVAILABILITIES, AVAILABILITY_META, SIZING_MODES, SIZING_MODE_LABEL } from '@/lib/catalog';
import { formatMoney, parseCents } from '@/lib/money';

export interface ProductFormValues {
  id: string;
  name: string;
  slug: string;
  description: string;
  base_price_cents: string;
  currency: string;
  image_url: string;
  active: boolean;
  cad_model: string;
  display_order: string;
  availability: string;
  sizing_modes: string[];
}

/**
 * Create/edit form. A client component only so useActionState can keep the
 * typed values on screen when validation fails; all validation and the
 * admin check run in the saveProduct server action.
 */
export function ProductForm({ initial }: { initial: ProductFormValues }) {
  const [state, action, pending] = useActionState<ProductFormState, FormData>(saveProduct, {
    errors: [],
  });
  // Display only: the server re-parses the posted value.
  const [cents, setCents] = useState(initial.base_price_cents);
  const [currency, setCurrency] = useState(initial.currency);
  const parsedCents = parseCents(cents);
  const priceHint =
    parsedCents === null
      ? 'Whole cents, e.g. 8900.'
      : formatMoney(parsedCents, /^[a-z]{3}$/i.test(currency) ? currency : 'usd');

  return (
    <form action={action} className={styles.form}>
      {state.errors.length > 0 ? (
        <div className={styles.formError} role="alert">
          <ul>
            {state.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <input type="hidden" name="id" value={initial.id} />

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          name="name"
          defaultValue={initial.name}
          required
          maxLength={120}
        />
      </label>

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Slug</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="slug"
            defaultValue={initial.slug}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={80}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Price (cents)</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="base_price_cents"
            value={cents}
            onChange={(e) => setCents(e.target.value)}
            required
            inputMode="numeric"
            pattern="[0-9]+"
            placeholder="8900"
            aria-describedby="price-hint"
          />
          <span className={styles.fieldHint} id="price-hint" aria-live="polite">
            {priceHint}
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Currency</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            required
            maxLength={3}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Display order</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="display_order"
            defaultValue={initial.display_order}
            inputMode="numeric"
            pattern="[0-9]+"
            aria-describedby="order-hint"
          />
          <span className={styles.fieldHint} id="order-hint">
            Lower comes first in the shop.
          </span>
        </label>
      </div>

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Availability</span>
          <select
            className={styles.input}
            name="availability"
            defaultValue={initial.availability}
            aria-describedby="availability-hint"
          >
            {AVAILABILITIES.map((value) => (
              <option key={value} value={value}>
                {AVAILABILITY_META[value].label}: {AVAILABILITY_META[value].hint}
              </option>
            ))}
          </select>
          <span className={styles.fieldHint} id="availability-hint">
            Available needs a CAD model descriptor and a price above 0.
          </span>
        </label>
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>Sizing modes sold</legend>
          {SIZING_MODES.map((mode) => (
            <label key={mode} className={styles.checkboxField}>
              <input
                type="checkbox"
                name="sizing_modes"
                value={mode}
                defaultChecked={initial.sizing_modes.includes(mode)}
              />
              {SIZING_MODE_LABEL[mode]}
            </label>
          ))}
          <span className={styles.fieldHint}>
            Checkout sells custom fit only until preset value sets exist (DESIGN.md 7a.3).
          </span>
        </fieldset>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Description</span>
        <textarea
          className={styles.input}
          name="description"
          defaultValue={initial.description}
          rows={3}
          maxLength={600}
        />
        <span className={styles.fieldHint}>Shown under the name in the app shop.</span>
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Legacy image URL</span>
        <input
          className={styles.input}
          name="image_url"
          type="url"
          defaultValue={initial.image_url}
          placeholder="https://"
        />
        <span className={styles.fieldHint}>
          https only. Used only while the product has no uploaded main photo.
        </span>
      </label>

      <label className={styles.checkboxField}>
        <input type="checkbox" name="active" defaultChecked={initial.active} />
        Active (unchecked archives the product: hidden, kept on past orders)
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>CAD model descriptor (JSON)</span>
        <textarea
          className={`${styles.input} ${styles.mono}`}
          name="cad_model"
          defaultValue={initial.cad_model}
          rows={6}
          spellCheck={false}
        />
        <span className={styles.fieldHint}>
          Which parametric model the pipeline builds for this product. Required before it can be
          made available, and before an order for it can be marked paid.
        </span>
      </label>

      <div className={styles.actionBar}>
        <button type="submit" className={styles.downloadBtn} disabled={pending}>
          {pending ? 'Saving' : 'Save product'}
        </button>
      </div>
    </form>
  );
}
