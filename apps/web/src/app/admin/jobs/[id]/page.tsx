import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import styles from '../../admin.module.css';
import { AdminShell } from '../../AdminShell';
import { StatusBadge } from '../../StatusBadge';
import { requireAdmin } from '@/lib/admin-auth';
import { getTriage } from '@/lib/data';
import { formatDateTime, groupMeasurements, shortId } from '@/lib/view';

export const metadata: Metadata = {
  title: 'Job detail - Zells admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function gateRange(min?: number, max?: number): string {
  if (min != null && max != null) {
    return `expected ${min} to ${max} mm`;
  }
  if (min != null) {
    return `expected at least ${min} mm`;
  }
  if (max != null) {
    return `expected at most ${max} mm`;
  }
  return 'outside plausible range';
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin();
  const { id } = await params;

  const triage = await getTriage(id);
  if (!triage) {
    notFound();
  }

  const { job, gates, values } = triage;
  const failedGates = gates.filter((gate) => !gate.ok);
  const grouped = groupMeasurements(values, gates);
  const hasValues = values != null && grouped.presentCount > 0;

  return (
    <AdminShell fake={ctx.fake}>
      <Link href="/admin" className={styles.backLink}>
        Back to queue
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.detailHead}>
          <h1 className={`${styles.title} ${styles.mono}`}>{shortId(job.id)}</h1>
          <StatusBadge status={job.status} />
        </div>
      </div>

      <p className={styles.sectionLabel}>Job state</p>
      <div className={styles.factGrid}>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Job id</div>
          <div className={styles.factValue}>{job.id}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Scan id</div>
          <div className={styles.factValue}>{job.scan_id}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Step</div>
          <div className={styles.factValue}>{job.step}</div>
        </div>
        <div className={styles.fact}>
          <div className={styles.factTerm}>Status</div>
          <div className={styles.factValue}>{job.status}</div>
        </div>
      </div>

      {job.error ? (
        <>
          <p className={styles.sectionLabel}>Error payload</p>
          <div className={styles.errorPayload}>
            {job.error.message ? (
              <p className={styles.errorMessage}>{job.error.message}</p>
            ) : (
              <p className={styles.errorMessage}>Job carries an error with no message.</p>
            )}

            {failedGates.length > 0 ? (
              <div className={styles.gateList}>
                {failedGates.map((gate) => (
                  <div key={gate.key} className={styles.gateRow}>
                    <span className={styles.gateKey}>{gate.key}</span>
                    <span className={styles.gateDetail}>
                      got {gate.value ?? 'null'} mm, {gateRange(gate.min, gate.max)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <pre className={styles.codeBlock}>{JSON.stringify(job.error, null, 2)}</pre>
          </div>
        </>
      ) : null}

      <p className={styles.sectionLabel}>Measurements (mm)</p>
      {hasValues ? (
        <>
          <div className={styles.legLength}>
            <span className={styles.legLengthLabel}>Leg_Length</span>
            <span className={styles.legLengthValue}>
              {grouped.legLength.value ?? '-'}
              {grouped.legLength.value != null ? <span className={styles.dimUnit}> mm</span> : null}
            </span>
          </div>

          <div className={styles.sliceGrid}>
            {grouped.slices.map((group) => (
              <div key={group.slice} className={styles.sliceCard}>
                <div className={styles.sliceHead}>
                  <span className={styles.sliceName}>{group.slice}</span>
                  <span className={styles.slicePos}>{group.position}</span>
                </div>
                <table className={styles.dimTable}>
                  <tbody>
                    {group.cells.map((cell) => (
                      <tr key={cell.key} className={cell.outOfRange ? styles.dimBad : undefined}>
                        <td className={styles.dimName}>
                          {cell.dim}
                          {cell.outOfRange && cell.gate ? (
                            <span className={styles.dimRange}>
                              {gateRange(cell.gate.min, cell.gate.max)}
                            </span>
                          ) : null}
                        </td>
                        {cell.value != null ? (
                          <td className={styles.dimValue}>
                            {cell.value} <span className={styles.dimUnit}>mm</span>
                          </td>
                        ) : (
                          <td className={styles.dimMissing}>-</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className={styles.muted}>
          No measurements recorded for this scan yet. Extraction has not produced a payload.
        </p>
      )}

      <p className={styles.sectionLabel}>Break-glass STL download</p>
      <div className={styles.actionBar}>
        <a className={styles.downloadBtn} href={`/admin/api/stl/${job.id}`}>
          Download STL
        </a>
        <p className={styles.actionNote}>
          Issues a short-lived signed URL server-side and writes an audit_log row before the
          download. Use only when a customer or print handoff needs the file directly. Returns a
          404 if this job has no STL artifact yet.
        </p>
      </div>
    </AdminShell>
  );
}
