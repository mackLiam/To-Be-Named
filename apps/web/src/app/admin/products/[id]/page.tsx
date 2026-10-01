import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { ProductForm } from '../ProductForm';
import { requireAdmin } from '@/lib/admin-auth';
import { getProduct } from '@/lib/data';
import { centsToPriceInput } from '@/lib/shop';

export const metadata: Metadata = {
  title: `Edit product - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin();
  const product = await getProduct((await params).id);
  if (!product) {
    notFound();
  }

  return (
    <AdminShell fake={ctx.fake}>
      <Link href="/admin/products" className={styles.backLink}>
        Back to products
      </Link>
      <div className={styles.pageHead}>
        <h1 className={styles.title}>{product.name}</h1>
      </div>
      <ProductForm
        initial={{
          id: product.id,
          name: product.name,
          slug: product.slug,
          description: product.description,
          price: centsToPriceInput(product.base_price_cents),
          currency: product.currency,
          image_url: product.image_url ?? '',
          active: product.active,
          cad_model: product.cad_model ? JSON.stringify(product.cad_model, null, 2) : '',
        }}
      />
    </AdminShell>
  );
}
