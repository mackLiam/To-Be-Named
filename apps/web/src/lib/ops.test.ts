import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FAKE_AUDIT_ROWS,
  compactDetail,
  isAuditSubjectTable,
  listAuditLog,
  retryPipelineJob,
  subjectHref,
} from './ops';

function clientWith(error: { code?: string; message: string } | null) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error });
  return { client: { rpc } as never, rpc };
}

describe('retryPipelineJob', () => {
  it('calls the RPC with the actor and id', async () => {
    const { client, rpc } = clientWith(null);
    await expect(retryPipelineJob(client, 'a@x.test', 'job-1')).resolves.toEqual({ error: null });
    expect(rpc).toHaveBeenCalledWith('retry_pipeline_job', { p_id: 'job-1', p_actor: 'a@x.test' });
  });

  it('maps check_violation', async () => {
    const { client } = clientWith({ code: '23514', message: 'x' });
    const res = await retryPipelineJob(client, 'a', 'j');
    expect(res.error).toMatch(/Only a dead-lettered job can be retried/);
  });

  it('maps unique_violation', async () => {
    const { client } = clientWith({ code: '23505', message: 'x' });
    expect(await retryPipelineJob(client, 'a', 'j')).toEqual({
      error: 'Another job for this scan is already active.',
    });
  });

  it('throws on anything else', async () => {
    const { client } = clientWith({ code: '42501', message: 'denied' });
    await expect(retryPipelineJob(client, 'a', 'j')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('listAuditLog (fake mode)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns rows newest first and paginates with lookahead', async () => {
    const page1 = await listAuditLog({ page: 1, pageSize: 3 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.hasNext).toBe(true);
    const page2 = await listAuditLog({ page: 2, pageSize: 3 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.hasNext).toBe(false);
  });

  it('filters by an allowlisted table', async () => {
    const res = await listAuditLog({ table: 'orders', page: 1, pageSize: 25 });
    expect(res.rows.every((r) => r.subject_table === 'orders')).toBe(true);
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it('ignores an unknown table', async () => {
    const res = await listAuditLog({ table: 'users; drop', page: 1, pageSize: 25 });
    expect(res.rows).toHaveLength(FAKE_AUDIT_ROWS.length);
  });
});

describe('helpers', () => {
  it('allowlists tables', () => {
    expect(isAuditSubjectTable('scans')).toBe(true);
    expect(isAuditSubjectTable('auth.users')).toBe(false);
    expect(isAuditSubjectTable(undefined)).toBe(false);
  });

  it('truncates detail', () => {
    expect(compactDetail(null)).toBe('-');
    expect(compactDetail({ a: 1 })).toBe('{"a":1}');
    const out = compactDetail({ k: 'x'.repeat(200) }, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('...')).toBe(true);
  });

  it('links only orders and jobs', () => {
    expect(subjectHref('orders', 'o1')).toBe('/admin/orders/o1');
    expect(subjectHref('pipeline_jobs', 'j1')).toBe('/admin/jobs/j1');
    expect(subjectHref('scans', 's1')).toBeNull();
    expect(subjectHref('orders', null)).toBeNull();
  });
});
