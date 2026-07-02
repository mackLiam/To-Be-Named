import { listProducts, type Product } from '../lib/api';
import { useAsyncList } from './useAsyncList';

export function useProducts() {
  return useAsyncList<Product>(listProducts);
}
