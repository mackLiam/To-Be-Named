'use client';

import { useActionState } from 'react';

import { saveProduct, type ProductFormState } from '../actions';
import styles from '../admin.module.css';

export interface ProductFormValues {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: string;
  currency: string;
  image_url: string;
  active: boolean;
  cad_model: string;
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
          <span className={styles.fieldLabel}>Price</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="price"
            defaultValue={initial.price}
            required
            inputMode="decimal"
            placeholder="89.00"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Currency</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            name="currency"
            defaultValue={initial.currency}
            required
            maxLength={3}
          />
        </label>
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
        <span className={styles.fieldLabel}>Image URL</span>
        <input
          className={styles.input}
          name="image_url"
          type="url"
          defaultValue={initial.image_url}
          placeholder="https://"
        />
        <span className={styles.fieldHint}>https only. Leave empty for no image.</span>
      </label>

      <label className={styles.checkboxField}>
        <input type="checkbox" name="active" defaultChecked={initial.active} />
        Available in the shop
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
          Which parametric model the pipeline builds for this product. Required before an order for
          it can be marked paid.
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
