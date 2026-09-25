# identity module (Phase 1)

**Purpose:** who is using the system, what they are allowed to do, and the record of what everyone did.

**Owns these tables:** `users`, `user_sessions` (refresh tokens), `auth_challenges` (one-time sign-in steps and password links), `sign_in_throttles`, `audit_logs`.

**Endpoints (see `packages/contracts/openapi.yaml`):**
- Sign-in, `auth.controller.ts`: `POST /auth/login`, `/auth/2fa/verify`, `/auth/2fa/setup`, `/auth/2fa/enable`, `/auth/refresh`, `/auth/logout`, `/auth/set-password`, `/auth/change-password`, `GET /auth/me`.
- User management (ADMIN only), `users.controller.ts`: `GET/POST /users`, `GET/PATCH /users/{id}`, `POST /users/{id}/deactivate`, `/reactivate`, `/reset-sign-in`.

## Where things are

| File | What it does |
|---|---|
| `auth.service.ts` | Every sign-in flow, as the contract describes it |
| `account-rules.ts` | Small pure rules: may this account be used, which roles need an employee link or two-factor |
| `accounts.service.ts` | Shared account steps: end all access, issue a one-time password link, switch off a leaver's account |
| `users.service.ts` | User management for administrators |
| `access-token.guard.ts`, `kiosk-scope.guard.ts`, `roles.guard.ts` | The global sign-in wall, the kiosk limit and the role check, in that order |
| `sign-in-place.ts` | Where a sign-in came from (the dashboard or a kiosk), and the letter a half-done sign-in carries so it is finished in the same place |
| `password.ts`, `totp.ts`, `secret-box.ts`, `tokens.service.ts` | scrypt hashing, authenticator codes (RFC 6238), secret encryption, tokens |
| `sign-in-throttle.service.ts` | The atomic lockouts: per email, per account, and per worker for the kiosk's Ghana Card check |
| `audit.service.ts` | The append-only audit log every module writes through |

User management is its own Nest module (`users.module.ts`) only because it needs the workforce module to check employee links, while workforce already uses identity for the audit log. This keeps the imports one-way.

## Two administrators (Phase 7)

An ADMIN account that was created, promoted, reset or switched back on waits
for a **second** administrator before it can be used at all
(`awaitsAdminConfirmation` in `account-rules.ts`, which `mayUseAccount` already
asks, so sign-in, refresh and every request refuse it alike). The second half
is `POST /users/{id}/confirm-admin`. The rules, including the one shortcut for
a company gaining its first second administrator, are in docs/plan/06,
"Two administrators".

## Rules that must hold

- Passwords are hashed with scrypt. Nobody ever sees another person's password: accounts get a one-time link and the owner chooses their own.
- Access tokens live 15 minutes, and the guard checks the account on every request. Refresh tokens live in an `HttpOnly` cookie, rotate on every use and can be revoked.
- ADMIN and HR_PAYROLL accounts must use two-factor authentication — at sign-in, at refresh and on every request.
- Sign-in errors never reveal whether an email address has an account. Wrong passwords and wrong codes are throttled.
- **Signing in says where from.** The browser's `Origin` decides: an address in `CORS_ORIGINS` is the dashboard, one in `KIOSK_ORIGINS` is a kiosk at a site, and anything else is refused. The two lists may never share an address (the API refuses to start).
- **A kiosk sign-in gets no refresh cookie** and a token that only opens the kiosk screens, because a kiosk is shared by everyone at the site. Two-factor is never set up on one, and a half-done sign-in is finished where it started.
- An administrator can never change (except their name), switch off or reset their own account.
- Every change to important data writes an audit log entry with IDs and field names, never personal values or secrets.
