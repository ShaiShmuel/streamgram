# StreamGram setup, management, and personal access

StreamGram stores instance configuration and a token-keyed map of Telegram accounts in `data/config.json`. It needs no database. `TelegramClientManager` owns the shared pool of lazy clients, one per account token.

## Browser setup and routing

Open `/` to initialize management. The four steps are admin protection, instance credentials, Telegram connection, and Stremio installation. Protection is enabled by default and requires an admin password of at least eight characters. After the protection step establishes the admin session, existing environment values prefill non-secret fields; saved Telegram API ID and API hash show one `*` per hidden character followed by their last three characters. The TMDB preview is capped at 70 `*` characters followed by its last three characters. These previews are available only through the guarded admin configuration endpoint. Telegram API ID uses a text field; leaving any credential field blank preserves its saved value. Saved configuration overrides environment defaults.

Once management is initialized, `/` opens the admin dashboard or its login screen. Removing every account does not reopen first-run setup. Existing installations with an admin password inherit protection; existing installations without one remain unprotected. The Admin settings page can enable or disable protection. Server settings contains instance credentials, language, connection checks, and cache controls. **Unprotected management is accessible to anyone who can reach the instance.**

`/:userToken/configure` redirects to `/?action=settings&token=…`. Both links always open that account's personal page, even if the browser is logged in as an administrator. The personal page never requests account lists or instance configuration. Users can install immediately, rename their account, choose a personal search language, select optional folder/channel catalogs, reconnect the same Telegram identity, or delete their account. New accounts inherit the instance default search language. Browser and interface language preferences do not set or update the account’s search language. Reconnection preserves the account’s existing language preference. Only explicitly saving the Search language field changes that preference; choosing Use instance default resumes inheritance from the server. Personal changes cannot update TMDB credentials or instance defaults.

The existing `/:userToken/manifest.json`, catalog, search, stream, and watch URLs are preserved. Selecting catalogs is optional and is not an installation prerequisite.

## Admin API

- `GET /setup/status`: only public initialization/protection flags; no accounts, phone details, tokens, or credential prefixes.
- `GET /setup/bootstrap`: first-run protection defaults only, closed after initialization.
- `POST /setup/initialize`: saves the initial management configuration and opens an admin session. Available once.
- `POST /admin/login { "password": "…" }`: opens an eight-hour process-local session.
- `GET /admin/session`: checks authentication; `POST /admin/session` opens a browser session for an authorized administrator, including unprotected instances.
- `POST /admin/logout`: invalidates the current session.
- `GET /setup/admin-status`, `POST /setup/config`: guarded instance configuration.
- `GET /admin/accounts`, `DELETE /admin/accounts/:token`: guarded account management.
- `GET/POST /admin/invitations`, `DELETE /admin/invitations/:id`: guarded invitation management.
- `GET /setup/config/export`, `POST /setup/config/import`: guarded backup/restore.
- `GET /cache/stats`, `DELETE /cache/clear`: guarded cache administration.

The session cookie is HttpOnly, SameSite=Strict, scoped to `/`, and Secure over HTTPS. Restarting the process expires all browser sessions. Password/protection changes invalidate other sessions. New passwords use salted scrypt hashes; a successfully verified legacy SHA256 password is upgraded automatically. Management API clients may continue to send `X-Admin-Password`.

Browser management mutations must originate from the request origin or configured public origin. Configure the reverse proxy to overwrite forwarded protocol headers. Stremio's cross-origin GET/HEAD streaming remains available. Serve the dashboard and streaming endpoints over HTTPS.

Admin login and `x-admin-password` authentication share a per-IP failure counter. Five failures within 15 minutes block further password verification for 15 minutes from the fifth failure, returning HTTP 429 with `Retry-After` in seconds. Successful verification resets the counter; missing credentials do not count, and existing browser sessions continue to work. The counter is process-local and resets on restart.

## Personal API

Prefer `Authorization: Bearer <userToken>` on `/settings`, `/name`, `/folders`, `/channels`, and `/telegram-status`. Existing `?token=…` forms remain supported. Missing and invalid tokens return 401; there is no first-account fallback. `/settings` accepts only `language` (`en`, `he`, `ru`, `ar`, `es`, or `null` to inherit). `/name` accepts only `name` (up to 80 characters). Unknown fields are rejected.

`DELETE /auth/logout/:token` removes that account, invalidates its links and pending authentication, and disconnects its managed client. A bearer token, when supplied, must match the account in the path. Legacy token-bearing deletion URLs remain supported.

Private user links grant account access without a separate user password. Treat them as credentials and share each link only with its owner.

## Invitations and Telegram authentication

Admins create seven-day, single-use invitations. The creation response contains the opaque secret once; persistence stores its SHA256 hash. The browser constructs `/?invite=…` for copying or sharing. There is no email delivery integration. `GET /invitations/:secret` reports validity; used, revoked, expired, and unknown links are rejected clearly.

On startup, legacy invitation maps and ISO date strings are migrated atomically to the current array and numeric timestamps. Existing invitation IDs, hashes, metadata, and used/revoked states are preserved. Invalid invitation records stop startup without overwriting the saved configuration.

Every phone/QR request carries one explicit authentication context:

- Admin browser session or legacy password header.
- `X-Invitation-Token: <invitation secret>`.
- `Authorization: Bearer <userToken>` for personal reconnection (legacy `?token=…` also works).

Personal/invitation context takes precedence over an admin cookie. Attempts are bound to that principal and are held only in memory. Restarting the server requires starting a new attempt, but valid invitation records survive restart.

Phone flow:

```text
POST /auth/send-code   { "phone": "+15551234567" }
# Returns attemptId. Retain it through retries and 2FA.
POST /auth/verify-code { "phone": "+15551234567", "code": "12345", "attemptId": "…", "password": "optional-2fa" }
```

QR flow:

```text
POST /auth/qr/generate
GET  /auth/qr/status/:qrToken
# If passwordRequired is true:
POST /auth/qr/status/:qrToken { "password": "…" }
```

The server obtains the verified Telegram identity, then rechecks the initiating principal and invitation validity before committing. Account creation and invitation consumption are one atomic file replacement with no asynchronous gap. Concurrent completions cannot reuse an invite. An existing Telegram identity keeps its account token/preferences; a personal reconnect must match its identity. Failed code/password attempts may retry until expiry and do not consume the invitation.

## Backups and private data

Backups support the users map, per-account language, names, Telegram identity, and folder/channel preferences. Invalid maps, mismatched tokens, duplicate identities, unknown keys, and invalid preferences are rejected. Restore preserves the current admin password and protection setting, keeps management initialized, invalidates invitations/browser sessions/pending authentication, and disconnects managed clients.

Keep `data/` and backups private: they contain Telegram session strings and instance credentials. Never log session strings or include them in public/personal responses. Multiple server processes must not share one config file; invitation atomicity assumes the application's single-process deployment model.

### International phone numbers and two-step verification

Phone entry accepts international country codes without selecting a default country. Spaces, dashes and parentheses are normalized, and the `00` international prefix is accepted alongside `+`. Bare local numbers starting with a trunk zero are rejected rather than assigned a country.

The Telegram password field appears only after Telegram requests two-step verification. Once the code is accepted, the server preserves that temporary session and retries the password directly without reusing the one-time code, following [Telegram’s two-step authorization flow](https://core.telegram.org/api/auth#2fa). A wrong password leaves the attempt and invitation available for retry until expiry.

## Admin password recovery

An authenticated admin can enable `passwordRecoveryEnabled` through
`PUT /admin/notifications`. Recovery defaults to disabled and uses the same
`botToken` and `chatId` as notifications, independently of routine alert settings.
It requires a configured HTTPS public URL and an accessible notification chat.
Private chats, groups, supergroups, and channels are supported. Legacy
`recoveryChatId` fields remain accepted in backups but do not select a destination.
`POST /admin/notifications/recovery-test` tests the saved recovery destination.
The bot must have access to the configured chat. Reset links are visible to
anyone with access to that chat.

- `POST /admin/password-reset/request`: public, same-origin protected; always
  returns `{ "success": true }` without disclosing configuration or delivery.
- `POST /admin/password-reset/complete { "token": "…", "password": "…" }`:
  public, same-origin protected; requires a valid single-use token and an
  8–1024-character password. Saves a salted scrypt hash, expires previous admin
  sessions/authentication owners, clears password lockouts, and issues the normal
  eight-hour browser session. Personal tokens and Telegram sessions stay valid.

Reset links use the configured public URL and place their 32-byte random secret
in the URL fragment. The browser removes it from the address bar before rendering
and keeps it only in page memory. Opening the link does not consume it; refreshing
that page after removal requires reopening the Telegram link. The server stores
only its hash and rejects it at exactly ten minutes after creation. A failed
password write preserves the current password and permits retry before expiry.

Only one link can be pending. Requests are limited to five per connection IP
within 15 minutes and delivery attempts to one per instance per minute; suppressed
requests have the same response. Delivery rechecks that the notification destination is accessible,
disables link previews, and prioritizes recovery with bounded retries. Failed
or expired delivery invalidates the link. Restart, backup restore, notification
settings changes, and password/protection changes invalidate pending links.
Backups include recovery configuration but never pending links.
