import type { AdminDecision } from './access';

/**
 * Break-glass STL download logic. Kept framework-free and dependency-injected
 * so it can be unit tested with a mocked Supabase client. The route handler in
 * app/admin/stl/[jobId]/route.ts is a thin adapter that supplies the real
 * service-role client and maps the result to an HTTP Response.
 *
 * Rules enforced here:
 *  - non-admin  -> 404 (never reveal the endpoint exists)
 *  - no backend -> 501 (clear "not configured" message)
 *  - success    -> a short-lived signed URL is issued AND an audit_log row is
 *                  written BEFORE the redirect (DESIGN.md sections 9.1, 9.8).
 *                  If the audit write fails we do NOT redirect, so access is
 *                  never granted without a recorded trail.
 */

export const STL_BUCKET = 'stls';
export const SIGNED_URL_TTL_SECONDS = 60;

interface SupaError {
  message: string;
}

interface JobArtifacts {
  stl_path?: string;
}

interface JobLookupRow {
  scan_id: string;
  artifacts: JobArtifacts | null;
}

interface JobQuery {
  select(columns: string): {
    eq(
      column: string,
      value: string,
    ): {
      maybeSingle(): Promise<{ data: JobLookupRow | null; error: SupaError | null }>;
    };
  };
  insert(row: Record<string, unknown>): Promise<{ error: SupaError | null }>;
}

/**
 * The structural subset of SupabaseClient that this handler needs. The real
 * client satisfies it; tests pass a hand-rolled mock.
 */
export interface StlServiceClient {
  from(table: string): JobQuery;
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<{ data: { signedUrl: string } | null; error: SupaError | null }>;
    };
  };
}

export interface StlDownloadDeps {
  decision: AdminDecision;
  serviceConfigured: boolean;
  jobId: string;
  getClient: () => StlServiceClient;
  ttlSeconds?: number;
}

export interface StlDownloadResult {
  status: number;
  location?: string;
  message?: string;
}

export async function handleStlDownload(deps: StlDownloadDeps): Promise<StlDownloadResult> {
  if (deps.decision.kind === 'deny') {
    // Do not reveal the endpoint to non-admins.
    return { status: 404 };
  }

  if (!deps.serviceConfigured) {
    return {
      status: 501,
      message:
        'STL download is not available: no Supabase service role is configured. ' +
        'Set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL (server-side only) to enable it.',
    };
  }

  const client = deps.getClient();

  const jobResult = await client
    .from('pipeline_jobs')
    .select('scan_id, artifacts')
    .eq('id', deps.jobId)
    .maybeSingle();

  if (jobResult.error) {
    return { status: 502, message: `Could not load job: ${jobResult.error.message}` };
  }

  const stlPath = jobResult.data?.artifacts?.stl_path;
  if (!jobResult.data || !stlPath) {
    // No such job, or no STL artifact yet. 404 either way (do not distinguish).
    return { status: 404 };
  }

  const ttlSeconds = deps.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  const signed = await client.storage.from(STL_BUCKET).createSignedUrl(stlPath, ttlSeconds);
  if (signed.error || !signed.data) {
    return {
      status: 502,
      message: `Could not sign STL URL: ${signed.error?.message ?? 'unknown error'}`,
    };
  }

  const actor =
    deps.decision.kind === 'allow'
      ? (deps.decision.user.email ?? deps.decision.user.id)
      : 'dev-fake';

  const audit = await client.from('audit_log').insert({
    actor,
    action: 'admin.stl_break_glass_download',
    subject_table: 'pipeline_jobs',
    subject_id: deps.jobId,
    detail: { stl_path: stlPath, bucket: STL_BUCKET, ttl_seconds: ttlSeconds },
  });

  if (audit.error) {
    // Never grant access without a durable audit trail.
    return { status: 502, message: `Could not write audit log: ${audit.error.message}` };
  }

  return { status: 302, location: signed.data.signedUrl };
}
