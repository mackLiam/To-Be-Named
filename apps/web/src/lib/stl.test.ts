import { describe, expect, it, vi } from 'vitest';

import type { AdminDecision } from './access';
import { handleStlDownload, STL_BUCKET, type StlServiceClient } from './stl';

const adminDecision: AdminDecision = {
  kind: 'allow',
  user: { id: 'u1', email: 'liam@zells.com' },
};

interface MockOptions {
  jobRow?: { scan_id: string; artifacts: { stl_path?: string } | null } | null;
  jobError?: { message: string } | null;
  signError?: { message: string } | null;
  insertError?: { message: string } | null;
}

function makeClient(opts: MockOptions) {
  const insert = vi.fn(async (_row: Record<string, unknown>) => ({
    error: opts.insertError ?? null,
  }));
  const createSignedUrl = vi.fn(async (path: string, expiresIn: number) => {
    if (opts.signError) {
      return { data: null, error: opts.signError };
    }
    return {
      data: { signedUrl: `https://signed.example/${path}?exp=${expiresIn}` },
      error: null,
    };
  });
  const maybeSingle = vi.fn(async () => ({
    data:
      opts.jobRow === undefined
        ? { scan_id: 's1', artifacts: { stl_path: 'u1/s1.stl' } }
        : opts.jobRow,
    error: opts.jobError ?? null,
  }));

  const client: StlServiceClient = {
    from: (_table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
    }),
    storage: {
      from: (_bucket: string) => ({ createSignedUrl }),
    },
  };

  return { client, insert, createSignedUrl, maybeSingle };
}

describe('handleStlDownload', () => {
  it('returns 404 for a non-admin without touching the client', async () => {
    const { client, maybeSingle } = makeClient({});
    const result = await handleStlDownload({
      decision: { kind: 'deny' },
      serviceConfigured: true,
      jobId: 'job-1',
      getClient: () => client,
    });
    expect(result.status).toBe(404);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('returns 501 when the service role is not configured', async () => {
    const result = await handleStlDownload({
      decision: adminDecision,
      serviceConfigured: false,
      jobId: 'job-1',
      getClient: () => {
        throw new Error('should not build a client when unconfigured');
      },
    });
    expect(result.status).toBe(501);
    expect(result.message).toMatch(/not available/i);
  });

  it('happy path: signs a short-lived url and writes an audit row before redirecting', async () => {
    const { client, insert, createSignedUrl } = makeClient({
      jobRow: { scan_id: 's1', artifacts: { stl_path: 'u1/s1.stl' } },
    });
    const result = await handleStlDownload({
      decision: adminDecision,
      serviceConfigured: true,
      jobId: 'job-1',
      getClient: () => client,
      ttlSeconds: 60,
    });

    expect(result.status).toBe(302);
    expect(result.location).toContain('https://signed.example/u1/s1.stl');
    expect(createSignedUrl).toHaveBeenCalledWith('u1/s1.stl', 60);
    expect(insert).toHaveBeenCalledTimes(1);
    const auditRow = insert.mock.calls[0]![0];
    expect(auditRow).toMatchObject({
      actor: 'liam@zells.com',
      action: 'admin.stl_break_glass_download',
      subject_table: 'pipeline_jobs',
      subject_id: 'job-1',
    });
    expect((auditRow.detail as { bucket: string }).bucket).toBe(STL_BUCKET);
  });

  it('returns 404 when the job has no STL artifact yet', async () => {
    const { client, insert } = makeClient({ jobRow: { scan_id: 's1', artifacts: null } });
    const result = await handleStlDownload({
      decision: adminDecision,
      serviceConfigured: true,
      jobId: 'job-1',
      getClient: () => client,
    });
    expect(result.status).toBe(404);
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not redirect if the audit write fails', async () => {
    const { client } = makeClient({
      jobRow: { scan_id: 's1', artifacts: { stl_path: 'u1/s1.stl' } },
      insertError: { message: 'audit table unavailable' },
    });
    const result = await handleStlDownload({
      decision: adminDecision,
      serviceConfigured: true,
      jobId: 'job-1',
      getClient: () => client,
    });
    expect(result.status).toBe(502);
    expect(result.location).toBeUndefined();
  });
});
