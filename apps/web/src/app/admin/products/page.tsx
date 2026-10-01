import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import { toggleProduct } from '../actions';
import styles from '../admin.module.css';
import { AdminShell } from '../AdminShell';
import { requireAdmin } from '@/lib/admin-auth';
import { listProducts } from '@/lib/data';
import { firstValue } from '@/lib/pagination';
import { formatMoney } from '@/lib/shop';
import { formatDateTime } from '@/lib/view';

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
  const error = firstValue((await searchParams).error);
  const products = await listProducts();

  return (
    <AdminShell fake={ctx.fake}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Products</h1>
          <p className={styles.subtitle}>
            What the app shop sells. Hidden products stay on past orders but cannot be bought.
          </p>
        </div>
        <Link href="/admin/products/new" className={styles.downloadBtn}>
          New product
        </Link>
      </div>

      {error ? <p className={styles.formError}>{error}</p> : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Image</th>
              <th>Name</th>
              <th>Slug</th>
              <th>Price</th>
              <th>CAD model</th>
              <th>In shop</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td className={styles.emptyRow} colSpan={8}>
                  No products yet. Add one so the shop has something to sell.
                </td>
              </tr>
            ) : (
              products.map((product) => (
                <tr key={product.id}>
                  <td>
                    {product.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- admin-entered remote URL, no loader configured
                      <img src={product.image_url} alt="" className={styles.thumb} />
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
                  <td className={styles.mono}>
                    {typeof product.cad_model?.provider === 'string' ? (
                      product.cad_model.provider
                    ) : (
                      <span className={styles.muted}>default</span>
                    )}
                  </td>
                  <td>{product.active ? 'Yes' : <span className={styles.muted}>Hidden</span>}</td>
                  <td className={`${styles.mono} ${styles.muted}`}>
                    {formatDateTime(product.updated_at)}
                  </td>
                  <td>
                    <form action={toggleProduct} className={styles.inlineForm}>
                      <input type="hidden" name="id" value={product.id} />
                      <input type="hidden" name="active" value={String(!product.active)} />
                      <button type="submit" className={styles.secondaryBtn}>
                        {product.active ? 'Hide' : 'Show'}
                      </button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
