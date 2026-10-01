# Auth email templates

Code-only emails: every template shows `{{ .Token }}` and none contains
`{{ .ConfirmationURL }}` or any sign-in link (the app verifies the code with
`verifyOtp` and never handles a redirect). Local dev reads these files through
`supabase/config.toml`; the hosted project needs each one pasted in by hand.

| File | Hosted dashboard (Authentication > Emails) | Subject |
|---|---|---|
| `confirmation.html` | Templates > Confirm signup | Your FORMS sign-up code |
| `magic_link.html` | Templates > Magic Link | Your FORMS sign-in code |
| `email_change.html` | Templates > Change Email Address | Confirm your email for FORMS |
| `reauthentication.html` | Templates > Reauthentication | Your FORMS confirmation code |
| `email_changed_notification.html` | Security notifications > Email address changed (turn it on) | Your FORMS email address was changed |

The copy says codes expire in 15 minutes: set the hosted Email OTP expiration
to 900 seconds to match.
