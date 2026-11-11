import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { PhotoManager } from '../PhotoManager';
import { ProductForm } from '../ProductForm';
import { requireAdmin } from '@/lib/admin-auth';
import { productImagePublicUrl } from '@/lib/catalog';
import { getProduct, listProductImages } from '@/lib/data';
import { getServerSupabaseUrl } from '@/lib/env';
import { firstValue } from '@/lib/pagination';

export const metadata: Metadata = {
  title: `Edit product - ${BRAND_NAME} admin`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdmin();
  const { id } = await params;
  const error = firstValue((await searchParams).error);
  const product = await getProduct(id);
  if (!product) {
    notFound();
  }
  const images = await listProductImages(product.id);
  const supabaseUrl = ctx.fake ? undefined : getServerSupabaseUrl();

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
          base_price_cents: String(product.base_price_cents),
          currency: product.currency,
          image_url: product.image_url ?? '',
          active: product.active,
          cad_model: product.cad_model ? JSON.stringify(product.cad_model, null, 2) : '',
          display_order: String(product.display_order),
          availability: product.availability,
          sizing_modes: product.sizing_modes,
        }}
      />

      <h2 className={styles.sectionLabel}>Photos</h2>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      <PhotoManager
        productId={product.id}
        photos={images.map((image) => ({
          id: image.id,
          alt_text: image.alt_text,
          is_main: image.is_main,
          src: supabaseUrl ? productImagePublicUrl(supabaseUrl, image.storage_path) : null,
        }))}
      />
    </AdminShell>
  );
}
