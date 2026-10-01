import Link from 'next/link';

import styles from './prose.module.css';
import { SiteFooter, SiteHeader } from './site-chrome';

export default function NotFound() {
  return (
    <main className={styles.main}>
      <SiteHeader />
      <article className={styles.article}>
        <p className={styles.bigNum} aria-hidden="true">
          404
        </p>
        <h1 className={styles.title}>Off the pitch.</h1>
        <p className={styles.lede}>This page does not exist, or it has moved.</p>
        <Link href="/" className={styles.action}>
          Back to the home page
        </Link>
      </article>
      <SiteFooter />
    </main>
  );
}
