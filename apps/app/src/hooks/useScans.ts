import { listScans, type Scan } from '../lib/api';
import { useAsyncList } from './useAsyncList';

export function useScans() {
  return useAsyncList<Scan>(listScans);
}
