import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { ProductForm } from '../ProductForm';
import { requireAdmin } from '@/lib/admin-auth';

export const metadata: Metadata = {
  title: `New product - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  const ctx = await requireAdmin();
  return (
    <AdminShell fake={ctx.fake}>
      <Link href="/admin/products" className={styles.backLink}>
        Back to products
      </Link>
      <div className={styles.pageHead}>
        <h1 className={styles.title}>New product</h1>
      </div>
      <p className={styles.subtitle}>Save the product first, then add photos on its page.</p>
      <ProductForm
        initial={{
          id: '',
          name: '',
          slug: '',
          description: '',
          base_price_cents: '',
          currency: 'usd',
          image_url: '',
          active: false,
          cad_model: '',
          display_order: '0',
          availability: 'coming_soon',
          sizing_modes: ['custom'],
        }}
      />
    </AdminShell>
  );
}
