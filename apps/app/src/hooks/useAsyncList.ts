import { useCallback, useEffect, useState } from 'react';

export interface AsyncListState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

export interface AsyncList<T> extends AsyncListState<T> {
  /** Re-run the fetcher, keeping current rows on screen until it resolves. */
  reload: () => void;
}

/**
 * Shared loading/error/data plumbing for the list screens (scans, orders,
 * products). Each screen hook (useScans, useOrders, useProducts) wraps this
 * with its own typed fetcher from src/lib/api.ts, so screens never import the
 * data layer directly.
 */
export function useAsyncList<T>(fetcher: () => Promise<T[]>): AsyncList<T> {
  const [state, setState] = useState<AsyncListState<T>>({
    data: [],
    loading: true,
    error: null,
  });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));

    fetcher()
      .then((data) => {
        if (!cancelled) {
          setState({ data, loading: false, error: null });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({ data: [], loading: false, error });
        }
      });

    return () => {
      cancelled = true;
    };
    // fetcher is a module-level function in every caller; generation is the
    // only intended trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  return { ...state, reload };
}
