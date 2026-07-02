import type { OrderStatus, ScanStatus } from '@zells/shared';

import { getSupabaseClient, hasSupabaseConfig } from './supabase';

/**
 * Data-layer stubs for the product surface (scans, orders, products). Phase
 * 0/1: no backend schema is final yet, so every function is safe to call with
 * zero configuration - it returns an empty list rather than throwing. Once
 * Supabase tables exist (docs/DESIGN.md section 8), the real query replaces
 * the stub inside each function; call sites (hooks in src/hooks/) do not
 * change.
 */

const USE_FAKE_DATA = !hasSupabaseConfig();

export interface Scan {
  id: string;
  leg: 'left' | 'right';
  status: ScanStatus;
  createdAt: string;
}

export interface Order {
  id: string;
  productName: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
}

export async function listScans(): Promise<Scan[]> {
  if (USE_FAKE_DATA) {
    return [];
  }
  const { data, error } = await getSupabaseClient()
    .from('scans')
    .select('id, leg, status, created_at')
    .order('created_at', { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    leg: row.leg,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function listOrders(): Promise<Order[]> {
  if (USE_FAKE_DATA) {
    return [];
  }
  const { data, error } = await getSupabaseClient()
    .from('orders')
    .select('id, product_name, status, total_cents, created_at')
    .order('created_at', { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    productName: row.product_name,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  }));
}

export async function listProducts(): Promise<Product[]> {
  if (USE_FAKE_DATA) {
    return [];
  }
  const { data, error } = await getSupabaseClient()
    .from('products')
    .select('id, name, description, price_cents')
    .eq('active', true);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
  }));
}
