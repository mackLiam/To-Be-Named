import { useCallback, useEffect, useMemo, useState } from 'react';

import { listMeasurements, listScans, requestScanDeletion, type Scan } from '../lib/api';
import {
  deleteErrorMessage,
  groupScanSessions,
  latestMeasurements,
  sessionLegs,
  type ScanSession,
} from '../lib/library';
import type { Measurements } from '@forms/shared';
import { useAsyncList } from './useAsyncList';

export function useScans() {
  return useAsyncList<Scan>(listScans);
}

/** The Library: per-leg rows grouped into left + right sessions, newest first. */
export function useScanSessions() {
  const { data, ...rest } = useScans();
  const sessions = useMemo(() => groupScanSessions(data), [data]);
  return { sessions, ...rest };
}

export interface ScanSessionDetail {
  session: ScanSession | null;
  /** Latest validated values per scan id; a leg without an entry has none yet. */
  measurements: Map<string, Measurements>;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** One session for the detail screen, plus its legs' measurements. */
export function useScanSession(key: string): ScanSessionDetail {
  const { sessions, loading, error, reload } = useScanSessions();
  const session = sessions.find((candidate) => candidate.key === key) ?? null;
  // Keyed on id and status so measurements refetch when a leg turns ready,
  // without refetching on every list reload.
  const legsKey = session
    ? sessionLegs(session)
        .map((scan) => `${scan.id}:${scan.status}`)
        .join(',')
    : '';

  const [measured, setMeasured] = useState<{
    rows: Map<string, Measurements>;
    loading: boolean;
    error: Error | null;
  }>({ rows: new Map(), loading: false, error: null });

  useEffect(() => {
    if (!legsKey) {
      return;
    }
    let cancelled = false;
    setMeasured((prev) => ({ ...prev, loading: true }));
    listMeasurements(legsKey.split(',').map((entry) => entry.slice(0, entry.lastIndexOf(':'))))
      .then((rows) => {
        if (!cancelled) {
          setMeasured({ rows: latestMeasurements(rows), loading: false, error: null });
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setMeasured({ rows: new Map(), loading: false, error: err });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [legsKey]);

  return {
    session,
    measurements: measured.rows,
    loading: loading || measured.loading,
    error: error ?? measured.error,
    reload,
  };
}

/** Delete both legs of a session. Resolves true on success; on failure sets a
 * user-facing message (deleteErrorMessage) and resolves false. */
export function useDeleteScanSession(session: ScanSession | null) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(async (): Promise<boolean> => {
    if (!session) {
      return false;
    }
    setDeleting(true);
    setError(null);
    try {
      await requestScanDeletion(sessionLegs(session).map((scan) => scan.id));
      return true;
    } catch (err) {
      setError(deleteErrorMessage(err));
      return false;
    } finally {
      setDeleting(false);
    }
  }, [session]);

  return { remove, deleting, error };
}
