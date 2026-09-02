import type { OrderStatus, ScanStatus } from '@zells/shared';

import { getSupabaseClient, hasSupabaseConfig } from './supabase';

/**
 * Data-layer stubs for the product surface (scans, orders, products). Phase
 * 0/1: no backend schema is final yet, so every function is safe to call with
 * zero configuration - with no Supabase env vars it returns the demo rows
 * below rather than throwing. Once
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
  // Absent for real rows until the products table carries imagery; screens
  // must render without it.
  imageUrl?: string;
}

/**
 * Demo rows for USE_FAKE_DATA mode, so every list screen renders populated in
 * a zero-backend dev build. Prices and the guard name mirror
 * supabase/seed.sql; ids are fixed strings, not uuids, because nothing here
 * is ever written back. Real rows replace these the moment
 * EXPO_PUBLIC_SUPABASE_* are set.
 */
// Remote Unsplash stills, deliberately not committed as assets: they exist
// only to fill the demo cards, and real product photography replaces them
// (see the imageUrl note on Product).
const DEMO_PRODUCTS: Product[] = [
  {
    id: 'demo-custom-guard',
    name: 'Zells Custom Shin Guard',
    description: 'Printed to your scan. One piece, vented shell, no strap gap at the ankle.',
    priceCents: 8900,
    imageUrl: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?w=1200&q=70',
  },
  {
    id: 'demo-custom-guard-pair',
    name: 'Zells Custom Shin Guard (pair)',
    description: 'Both legs scanned separately, so the left is not a mirror of the right.',
    priceCents: 16900,
    imageUrl: 'https://images.unsplash.com/photo-1560272564-c83b66b1ad12?w=1200&q=70',
  },
  {
    id: 'demo-keeper-guard',
    name: 'Zells Keeper Guard',
    description: 'Taller shell and a softer liner for goalkeepers taking shots at close range.',
    priceCents: 10900,
    imageUrl: 'https://images.unsplash.com/photo-1517927033932-b3d18e61fb3a?w=1200&q=70',
  },
];

const DEMO_SCANS: Scan[] = [
  { id: 'demo-scan-1', leg: 'right', status: 'ready', createdAt: '2026-08-28T17:12:00.000Z' },
  { id: 'demo-scan-2', leg: 'left', status: 'processing', createdAt: '2026-08-28T17:04:00.000Z' },
  { id: 'demo-scan-3', leg: 'left', status: 'failed', createdAt: '2026-08-21T09:41:00.000Z' },
];

const DEMO_ORDERS: Order[] = [
  {
    id: 'demo-order-1',
    productName: 'Zells Custom Shin Guard (pair)',
    status: 'in_production',
    totalCents: 16900,
    createdAt: '2026-08-29T10:02:00.000Z',
  },
  {
    id: 'demo-order-2',
    productName: 'Zells Custom Shin Guard',
    status: 'delivered',
    totalCents: 8900,
    createdAt: '2026-07-14T15:37:00.000Z',
  },
];

export async function listScans(): Promise<Scan[]> {
  if (USE_FAKE_DATA) {
    return DEMO_SCANS;
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
    return DEMO_ORDERS;
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
    return DEMO_PRODUCTS;
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
