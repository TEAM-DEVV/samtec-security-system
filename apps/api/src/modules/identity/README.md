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
| `access-token.guard.ts`, `roles.guard.ts` | The global sign-in wall and role check |
| `password.ts`, `totp.ts`, `secret-box.ts`, `tokens.service.ts` | scrypt hashing, authenticator codes (RFC 6238), secret encryption, tokens |
| `sign-in-throttle.service.ts` | The atomic per-email and per-account lockouts |
| `audit.service.ts` | The append-only audit log every module writes through |

User management is its own Nest module (`users.module.ts`) only because it needs the workforce module to check employee links, while workforce already uses identity for the audit log. This keeps the imports one-way.

## Rules that must hold

- Passwords are hashed with scrypt. Nobody ever sees another person's password: accounts get a one-time link and the owner chooses their own.
- Access tokens live 15 minutes, and the guard checks the account on every request. Refresh tokens live in an `HttpOnly` cookie, rotate on every use and can be revoked.
- ADMIN and HR_PAYROLL accounts must use two-factor authentication — at sign-in, at refresh and on every request.
- Sign-in errors never reveal whether an email address has an account. Wrong passwords and wrong codes are throttled.
- An administrator can never change (except their name), switch off or reset their own account.
- Every change to important data writes an audit log entry with IDs and field names, never personal values or secrets.
