import type { Metadata } from 'next';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import styles from '../prose.module.css';
import { SiteFooter, SiteHeader } from '../site-chrome';

export const metadata: Metadata = {
  title: `Privacy policy - ${BRAND_NAME}`,
  description: `What ${BRAND_NAME} collects when you scan your leg and order a guard, why, and how long we keep it.`,
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function PrivacyPage() {
  return (
    <main className={styles.main}>
      <SiteHeader />
      <article className={styles.article}>
        <p className={styles.kicker}>Privacy</p>
        <h1 className={styles.title}>Your scan, your data.</h1>
        <p className={styles.lede}>
          A leg scan is personal, and many of our players are under 18. This page says exactly what
          we collect, why, who handles it, and when it is deleted.
        </p>
        <p className={styles.notice} role="note">
          Draft. This policy is pending legal review and may change before launch.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Who we are</h2>
            <p>
              {BRAND_NAME} makes custom-fit, 3D-printed soccer shin guards from a scan of your leg.{' '}
              {BRAND_NAME} is a working name. Legal entity and address:{' '}
              <span className={styles.placeholder}>[to be completed with legal review]</span>.
            </p>
            <p>Questions about this policy or your data: {mail}.</p>
          </section>

          <section>
            <h2>What we collect</h2>
            <ul>
              <li>
                <strong>Your account email</strong>, so you can sign in and we can send order
                updates.
              </li>
              <li>
                <strong>Your leg scans.</strong> On iPhones with LiDAR, the scan is a 3D mesh of
                your lower leg. On iPhones without LiDAR, it is a set of photos that we reconstruct
                into a mesh on our own computer.
              </li>
              <li>
                <strong>Your leg measurements:</strong> the 25 measurements we extract from each
                scan to shape your guard.
              </li>
              <li>
                <strong>Your shipping name and address</strong>, to deliver your order.
              </li>
              <li>
                <strong>Payment.</strong> Payments are handled by Stripe. We never see or store your
                card number.
              </li>
              <li>
                <strong>Waitlist sign-ups.</strong> If you join a waitlist on this website, we keep
                your email and which product you asked about, only to email you when it is
                available. How long we keep it:{' '}
                <span className={styles.placeholder}>[to be completed with legal review]</span>.
              </li>
              <li>
                <strong>Basic device information about the capture</strong>, such as your iPhone
                model, so we can fix scan processing problems.
              </li>
            </ul>
          </section>

          <section>
            <h2>Why we use it</h2>
            <ul>
              <li>To make your guard and ship it to you.</li>
              <li>To let you reorder without scanning again.</li>
              <li>To find and fix problems when a scan does not process correctly.</li>
            </ul>
          </section>

          <section>
            <h2>How long we keep it</h2>
            <ul>
              <li>
                <strong>Raw scan files</strong> (the mesh or photos) are deleted automatically 30
                days after your scan is measured.
              </li>
              <li>
                <strong>Measurements</strong> are kept so a reorder needs no rescan.
              </li>
              <li>
                <strong>You can delete a scan at any time</strong> from the app. That erases its
                files and its measurements, unless the scan is part of an order.
              </li>
              <li>
                <strong>Order records</strong> are kept for as long as the law requires us to keep
                sales records.
              </li>
            </ul>
          </section>

          <section>
            <h2>Who processes it for us</h2>
            <ul>
              <li>
                <strong>Supabase</strong>: your account, our database and file storage.
              </li>
              <li>
                <strong>Stripe</strong>: payments.
              </li>
              <li>
                <strong>Onshape</strong>: our CAD system. It receives only your 25 measurements,
                never your scan, to generate the guard file. The working copy made for your order is
                deleted after the file is exported.
              </li>
              <li>
                <strong>Vercel</strong>: hosting for this website.
              </li>
              <li>
                <strong>Resend</strong>: order emails.
              </li>
            </ul>
          </section>

          <section>
            <h2>Children</h2>
            <p>
              Our guards are likely to be worn by players under 18. A parent or guardian should
              create the account and do the scan for a child.
            </p>
            <p>
              If you believe a child under 13 has given us data without a parent or guardian,
              contact {mail} and we will delete it.
            </p>
          </section>

          <section>
            <h2>Your choices</h2>
            <ul>
              <li>
                <strong>Access and correction:</strong> ask us for a copy of your data, or to
                correct it, by emailing {mail}.
              </li>
              <li>
                <strong>Deletion:</strong> delete a scan in the app, or email us.
              </li>
              <li>
                <strong>Account deletion:</strong> delete your account from the app.
              </li>
            </ul>
          </section>

          <section>
            <h2>Security</h2>
            <p>
              Data is encrypted in transit. Scan files are kept in private storage and can only be
              reached through short-lived links.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              If we change this policy, we will update this page. How we notify you of changes that
              affect data you have already given us:{' '}
              <span className={styles.placeholder}>[to be completed with legal review]</span>.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>Email {mail}.</p>
          </section>
        </div>
      </article>
      <SiteFooter />
    </main>
  );
}
