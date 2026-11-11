import type { AdminDecision } from '@/lib/access';
import { getAdminDecision } from '@/lib/admin-auth';
import { hasServiceRoleConfig } from '@/lib/env';
import {
  handleImageUpload,
  supabaseImageStorage,
  supabaseProductImageRepo,
} from '@/lib/product-image-writes';
import { UPLOAD_HEADER } from '@/lib/product-images';
import { createServiceRoleClient } from '@/lib/supabase-admin';

/**
 * Catalog photo upload. Thin adapter over handleImageUpload (unit tested in
 * lib/product-image-writes.test.ts), which enforces: aal2 admin or 404,
 * same-origin plus a custom header (CSRF), a 4 MB streamed cap, type by
 * magic bytes, dimensions, no animation, metadata stripped, a
 * server-generated path, and an audit row.
 * The body is the raw file; alt text rides in the query string.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const raw = await getAdminDecision();
  // Collapse every non-granting kind (including the MFA steps) into deny so
  // this endpoint never proceeds below aal2.
  const decision: AdminDecision =
    raw.kind === 'allow' || raw.kind === 'fake' ? raw : { kind: 'deny' };

  const result = await handleImageUpload({
    decision,
    serviceConfigured: hasServiceRoleConfig(),
    productId: id,
    origin: request.headers.get('origin'),
    host: request.headers.get('host'),
    uploadHeader: request.headers.get(UPLOAD_HEADER),
    contentType: request.headers.get('content-type'),
    contentLength: request.headers.get('content-length'),
    alt: new URL(request.url).searchParams.get('alt'),
    body: request.body,
    getWriter: () => {
      const client = createServiceRoleClient();
      return { repo: supabaseProductImageRepo(client), storage: supabaseImageStorage(client) };
    },
  });

  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
