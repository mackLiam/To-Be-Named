import { useEffect, useState } from 'react';

export interface AsyncListState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

/**
 * Shared loading/error/data plumbing for the three list screens (scans,
 * orders, products). Each screen hook (useScans, useOrders, useProducts)
 * wraps this with its own typed fetcher from src/lib/api.ts, so screens never
 * import the data layer directly.
 */
export function useAsyncList<T>(fetcher: () => Promise<T[]>): AsyncListState<T> {
  const [state, setState] = useState<AsyncListState<T>>({
    data: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
