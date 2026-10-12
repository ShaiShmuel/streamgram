# Admin security review — 2026-10-12

Reviewed management access, browser mutations, password reset, notification
configuration/delivery, backup import/export, and the dashboard settings pages.

## Protections verified

Protected management rejects unauthenticated requests and personal tokens on
admin routes. Browser mutations reject other origins and cross-site Fetch
Metadata, including public login and reset endpoints. First-run setup cannot
reopen after management initialization. Disabling protection is an explicit
option that makes management accessible to anyone who can reach the instance.

Admin passwords use salted scrypt hashes. Session cookies are HttpOnly and
SameSite=Strict, Secure over HTTPS, and expire after eight hours. Password and
protection changes, backup restores, and password resets invalidate old sessions
and pending admin authentication. Login failure counters and active session
storage now have bounded memory usage.

Reset secrets contain 32 random bytes; only their hashes are stored in the reset
record, with constant-time verification. Links expire at exactly ten minutes,
are single-use, and reject concurrent reuse. Requests are bounded per connection
IP and per instance. Changes to credentials, notification settings, public URL,
or restored configuration invalidate pending links. The browser removes the
secret from the address bar and does not persist it in browser storage.

Bot credentials are hidden in notification responses, and fetch errors containing
bot URLs are never logged. Backups remain admin-only; imports validate account
maps and preserve current admin credentials/protection. Sensitive API responses
and dashboard pages have no-store caching and no-referrer policies. Framing and
MIME sniffing are blocked; dashboard CSP restricts scripts to the same origin.
Cross-origin Stremio byte-range playback remains covered by integration tests.

Local runtime configuration has directory mode 0700 and file mode 0600. The
local .env was restricted to mode 0600. Runtime data, environment files, and
Telegram session files are ignored by Git and are not tracked.

## Dependency audit and validation

Security overrides patch affected production transitive dependencies while
retaining NestJS 10 and Express 4. The lockfile supports a frozen install.
`pnpm audit --prod` reports **zero critical/high/low findings** and **one moderate
finding**, [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75),
in NestJS SSE formatting. Its exploit requires application code forwarding
attacker-influenced SSE event IDs/types; StreamGram has no SSE routes or SSE
streams. This is an unused dependency path, not a patched advisory. Reassess it
before adding SSE or when upgrading NestJS; the published fix requires NestJS 11.

Validation passed: 415 Jest tests, 32 dashboard tests, TypeScript build, lint
(no errors; 141 existing warnings), frozen-lockfile install, and diff whitespace
checks. Telegram delivery tests use mocks; this review sent no live alerts or
password-reset links. No commit or push was performed.

## Deployment requirements

Use HTTPS for public access and keep admin protection enabled on exposed
instances. Recovery intentionally uses the same notification chat, including
groups: **anyone who can read that chat can use an active reset link and become
an admin**. Restrict that group to trusted admins. Keep backups and bot tokens
private. These deployment choices remain outside what automated tests can prove.
