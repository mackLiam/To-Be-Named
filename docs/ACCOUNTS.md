# Accounts and sign-in

How FORMS accounts work, what the 2026-09-30 security review found, and what
is still open. Architecture rationale lives in DESIGN.md sections 4, 8 and 9;
the database detail and hosted setup steps live in supabase/README.md
"Accounts and sign-in".

## How it works

- **No account needed to scan.** A guest is an anonymous Supabase user. Its
  scans stay on that phone (session in the Keychain/Keystore, this device
  only).
- **Paying needs an account.** Enforced in the database, not only the app:
  clients cannot insert orders at all (migration 0017); checkout runs on the
  server with the service role and refuses guests and accounts pending
  deletion.
- **Saving to an account.** A guest enters an email and a 6-digit code and
  every scan carries over (same user id). If that email already has an
  account, the guest signs in to it and the scans move there through a
  single-use transfer token (0012). Any failure leaves the guest signed in.
- **Standard shop account features:** delete account (App Store 5.1.1(v),
  GDPR erasure), download a copy of your data, sign out on this phone or on
  all devices, support, privacy and terms links.
- **Emails:** FORMS-branded, code only (no links to click, which defeats
  phishing), no tracking, codes expire in 15 minutes. Templates in
  supabase/templates/.
- **Staff admin panel:** confirmed allowlisted email, password, and an
  authenticator app code (TOTP, AAL2) on every sign-in.

## Security review findings (2026-09-30), all fixed

| Finding | Fix |
|---|---|
| Any client, guest included, could insert an order already marked paid for $0, which queued CAD work and showed as paid in admin | Client order inserts removed entirely (0012, 0017); checkout is server side |
| Orders could reference another user's scan | Removed with the client insert path |
| A client could delete a scan row directly, leaving the body-scan files where no purge finds them | Client delete policy dropped; deletion only through the RPC plus purge |
| Admin role was read from a table every user can write, so a planned `profiles.role` column would have let anyone self-promote | Admin is now allowlist + confirmed email + TOTP only |
| Sessions stored unencrypted in AsyncStorage, included in device backups | Keychain/Keystore via expo-secure-store |
| A deploy missing a public env var but holding the service key would have opened admin STL downloads to anyone | Fake mode now requires no service key |
| An account being deleted could still pay an open checkout, leaving an ownerless paid order | Checkout refuses; unpaid orders are cancelled; late payments are flagged for refund |
| A client could set `deleted_at` directly, or write a traversal-style `mesh_path` | Frozen for clients and format-checked (0017) |
| Email confirmation was off locally, so an address could be attached without proving the inbox | Confirmation required |

## Open items

Code:

- The admin order page crashes on an order whose account was deleted
  (`orders.user_id` is null). Only matters once the deletion worker runs
  with `--arm`. Files: apps/web/src/lib/types.ts, fake.ts, data.ts,
  src/app/admin/orders/[id]/page.tsx.

For Liam (cannot be done from code):

1. Supabase dashboard setup in supabase/README.md "Accounts and sign-in":
   email templates, "Confirm email" on, TOTP MFA on, 15-minute codes.
2. Custom SMTP from a FORMS address on your domain with SPF, DKIM and DMARC.
   Without it mail comes from Supabase's shared sender and does not show
   FORMS as the sender.
3. A new EAS dev build (expo-secure-store is a native module).
4. Enroll your authenticator on the admin panel right after deploying:
   whoever first signs in with a staff password sets up that account's MFA.
5. CAPTCHA or app attestation before launch. 6-digit codes can eventually
   be guessed by an attacker spread over many IP addresses; 8-digit codes
   are the alternative.
6. Legal decisions: how long order records (including addresses) are kept
   after an account is deleted, and parental consent for users under 16.
