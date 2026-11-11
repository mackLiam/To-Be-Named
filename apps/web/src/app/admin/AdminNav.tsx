'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import styles from './admin.module.css';
import { ADMIN_NAV, activeAdminNav } from '@/lib/admin-nav';

/**
 * Section links; the current one is marked for sight and assistive tech.
 * At phone width the row scrolls sideways, so the current link is scrolled
 * into view on each navigation.
 */
export function AdminNav() {
  const active = activeAdminNav(usePathname());
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <nav ref={navRef} className={styles.nav} aria-label="Admin">
      {ADMIN_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={styles.navLink}
          aria-current={item.href === active ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
