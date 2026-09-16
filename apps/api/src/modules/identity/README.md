# identity module (Phase 1)

**Purpose:** who is using the system, and what they are allowed to do.

**Will own these tables:** `users`, `sessions` (refresh tokens), `audit_logs`.

**Endpoints (see `packages/contracts/openapi.yaml`):** `POST /auth/login`, `POST /auth/2fa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.

## Rules that must hold

- Passwords are hashed with argon2id. The plain password is never stored or logged.
- Access tokens live 15 minutes. Refresh tokens live in an `HttpOnly` cookie, rotate on every use and can be revoked.
- ADMIN and HR_PAYROLL accounts must use two-factor authentication.
- Sign-in errors never reveal whether an email address has an account.
- Sign-in is rate-limited (add a rate limiter in this phase).
- Every change to important data writes an audit log entry: who, what, when, before and after.
