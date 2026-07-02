import { listOrders, type Order } from '../lib/api';
import { useAsyncList } from './useAsyncList';

export function useOrders() {
  return useAsyncList<Order>(listOrders);
}
