import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import { reorderProduct, toggleProduct } from '../actions';
import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { SubmitButton } from '../SubmitButton';
import { requireAdmin } from '@/lib/admin-auth';
import { adminErrorText } from '@/lib/admin-messages';
import { productStateMeta, resolveShopImage, sizingModesLabel } from '@/lib/catalog';
import { listMainImages, listProducts } from '@/lib/data';
import { getServerSupabaseUrl } from '@/lib/env';
import { firstValue } from '@/lib/pagination';
import { formatMoney } from '@/lib/shop';
import { formatDateTime, type StatusTone } from '@/lib/view';

const TONE_CLASS: Record<StatusTone, string | undefined> = {
  neutral: styles.toneNeutral,
  progress: styles.toneProgress,
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
};

export const metadata: Metadata = {
  title: `Products - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const error = adminErrorText(firstValue((await searchParams).error));
  const products = await listProducts();
  const mains = await listMainImages(products.map((product) => product.id));
  const supabaseUrl = ctx.fake ? undefined : getServerSupabaseUrl();

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Products</h1>
          <p className={styles.subtitle}>
            What the app shop sells, in shop order. Coming soon is listed but not purchasable;
            paused and archived are hidden. Archived products stay on past orders.
          </p>
        </div>
        <Link href="/admin/products/new" className={styles.primaryBtn}>
          New product
        </Link>
      </div>

      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order</th>
              <th>Image</th>
              <th>Name</th>
              <th>Slug</th>
              <th>Price</th>
              <th>Sizing</th>
              <th>CAD model</th>
              <th>Shop state</th>
              <th>Updated</th>
              <th>
                <span className={styles.srOnly}>Archive</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={10}>
                  No products yet. Add one so the shop has something to sell.
                </td>
              </tr>
            ) : (
              products.map((product, index) => {
                const image = resolveShopImage({
                  main: mains.get(product.id) ?? null,
                  imageUrl: product.image_url,
                  productName: product.name,
                  supabaseUrl,
                });
                const state = productStateMeta(product);
                return (
                  <tr key={product.id}>
                    <td>
                      <div className={styles.orderControls}>
                        {(['up', 'down'] as const).map((direction) => (
                          <form
                            key={direction}
                            action={reorderProduct}
                            className={styles.inlineForm}
                          >
                            <input type="hidden" name="id" value={product.id} />
                            <input type="hidden" name="direction" value={direction} />
                            <button
                              type="submit"
                              className={styles.secondaryBtn}
                              disabled={
                                direction === 'up' ? index === 0 : index === products.length - 1
                              }
                              aria-label={`Move ${product.name} ${direction}`}
                            >
                              {direction === 'up' ? 'Up' : 'Down'}
                            </button>
                          </form>
                        ))}
                      </div>
                    </td>
                    <td>
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element -- public bucket or admin-entered URL, no loader configured
                        <img src={image.src} alt={image.alt} className={styles.thumb} />
                      ) : (
                        <span className={styles.muted}>-</span>
                      )}
                    </td>
                    <td>
                      <Link href={`/admin/products/${product.id}`} className={styles.idLink}>
                        {product.name}
                      </Link>
                    </td>
                    <td className={styles.mono}>{product.slug}</td>
                    <td className={styles.mono}>
                      {formatMoney(product.base_price_cents, product.currency)}
                    </td>
                    <td>{sizingModesLabel(product.sizing_modes)}</td>
                    <td className={styles.mono}>
                      {typeof product.cad_model?.provider === 'string' ? (
                        product.cad_model.provider
                      ) : (
                        <span className={styles.muted}>default</span>
                      )}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${TONE_CLASS[state.tone]}`}>
                        {state.label}
                      </span>
                    </td>
                    <td className={`${styles.mono} ${styles.muted}`}>
                      {formatDateTime(product.updated_at)}
                    </td>
                    <td>
                      <form action={toggleProduct} className={styles.inlineForm}>
                        <input type="hidden" name="id" value={product.id} />
                        <input type="hidden" name="active" value={String(!product.active)} />
                        <SubmitButton
                          pendingLabel={product.active ? 'Archiving' : 'Restoring'}
                          variant="secondary"
                        >
                          {product.active ? 'Archive' : 'Restore'}
                        </SubmitButton>
                      </form>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
