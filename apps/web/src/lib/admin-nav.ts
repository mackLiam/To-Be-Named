/** Admin top-bar sections, in display order. */
export const ADMIN_NAV = [
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/print-queue', label: 'Print queue' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin', label: 'Pipeline queue' },
  { href: '/admin/waitlist', label: 'Waitlist' },
  { href: '/admin/audit', label: 'Audit log' },
] as const;

export type AdminNavHref = (typeof ADMIN_NAV)[number]['href'];

/**
 * Which section a path belongs to, for aria-current. Job detail pages live
 * under the pipeline queue (/admin), which is otherwise an exact match so it
 * does not claim every /admin/* path.
 */
export function activeAdminNav(pathname: string | null): AdminNavHref | null {
  if (!pathname) {
    return null;
  }
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/admin' || path.startsWith('/admin/jobs/') || path === '/admin/jobs') {
    return '/admin';
  }
  for (const item of ADMIN_NAV) {
    if (item.href !== '/admin' && (path === item.href || path.startsWith(`${item.href}/`))) {
      return item.href;
    }
  }
  return null;
}
