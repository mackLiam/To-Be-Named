import { getAdminDecision } from '@/lib/admin-auth';
import { hasServiceRoleConfig } from '@/lib/env';
import { handleStlDownload, type StlServiceClient } from '@/lib/stl';
import { createServiceRoleClient } from '@/lib/supabase-admin';

/**
 * Break-glass STL download. Thin adapter over handleStlDownload (unit tested in
 * lib/stl.test.ts), which enforces the rules that matter:
 *  - non-admin -> 404 (the endpoint never reveals itself)
 *  - a short-lived signed URL is minted with the SERVICE ROLE client, which is
 *    imported only here (server-only) and whose key never reaches the client
 *  - an audit_log row is written BEFORE the redirect; if that write fails, no
 *    redirect happens, so access is never granted without a durable trail
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;
  const decision = await getAdminDecision();

  const result = await handleStlDownload({
    decision,
    serviceConfigured: hasServiceRoleConfig(),
    jobId,
    // The service-role client structurally satisfies StlServiceClient. Built
    // lazily so it is never constructed for a denied or unconfigured request.
    getClient: () => createServiceRoleClient() as unknown as StlServiceClient,
  });

  if (result.status === 302 && result.location) {
    return new Response(null, {
      status: 302,
      headers: { Location: result.location, 'Cache-Control': 'no-store' },
    });
  }

  return new Response(result.message ?? null, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
