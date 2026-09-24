# 05 · API contract

**Design-first is how two people build one system at the same time.** The contract, `packages/contracts/openapi.yaml`, is written *before* the code. Samuel builds the dashboard against it using mock data. Francis builds the API to match it. When both halves meet, they fit.

The step-by-step workflow is in [Changing the API contract](../guides/05-api-contract-workflow.md).

## How the contract reaches both apps

```
packages/contracts/openapi.yaml       ← the agreement, written and reviewed by both
        │  pnpm contracts:generate (openapi-typescript)
        ▼
packages/contracts/src/generated/api.d.ts   ← TypeScript types, never edited by hand
        │
   ┌────┴──────────────────────────┐
   ▼                               ▼
apps/web                        apps/api
$api.useQuery('get', '/employees')   return type HealthResponse
mock handlers typed with Employee    Zod schemas matching the contract
```

CI runs `pnpm contracts:check`, which fails if the YAML is invalid or if someone forgot to regenerate the types.

## Conventions

- **Base path:** `/api/v1`. JSON, except two Phase 4 downloads: a payroll run bank file (`text/csv`) and a payslip (`application/pdf`). Every error, including on those two, is still `application/problem+json`. IDs are UUID version 7.
- **Money:** integer pesewas, with field names ending in `Pesewas`.
- **Time:** timestamps in UTC (ISO 8601); calendar dates as `YYYY-MM-DD`.
- **Errors:** Problem Details (RFC 9457) with `type`, `title`, `status`, `detail`, `traceId`, and `errors` for validation. Stack traces never leave the server. When several problems apply, the answer follows the order the API checks them: `401` (not signed in), `403` (wrong role), `400` (a bad ID or body), `404` (not found or not yours), `400` (a field that is wrong for this record, such as a device's kind), `403` (a second-person rule), then `409` (a clash with the current state). The mock API follows the same order.
- **Lists:** cursor pagination with `?cursor=&limit=` and a `nextCursor` in the response. Page numbers are not used.
- **Sign-in:** `Authorization: Bearer <access token>`. The refresh token lives only in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie that the browser sends only to `/api/v1/auth`.
- **Data minimisation:** responses include only what the role needs. `EmployeeListItem` has no Ghana Card number, and a full `Employee` record includes it only for ADMIN, HR_PAYROLL and the guard themselves.

## Endpoint map

| Area | Endpoints | Status |
|---|---|---|
| System | `GET /health`, `GET /system/info` (admin only) | **Built** |
| Auth | `POST /auth/login`, `POST /auth/2fa/verify`, `POST /auth/2fa/setup`, `POST /auth/2fa/enable`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/set-password` (one-time link), `POST /auth/change-password` | **Built** |
| Users (ADMIN) | `GET/POST /users`, `GET/PATCH /users/{id}`, `POST /users/{id}/deactivate`, `POST /users/{id}/reactivate`, `POST /users/{id}/reset-sign-in` | **Built** |
| Employees | `GET /employees`, `GET /employees/{id}` | **Built** |
| Employees (writes) | `POST /employees`, `PATCH /employees/{id}`, `POST /employees/{id}/terminate` | **Built** |
| Sites | `GET /sites`, `GET /sites/{id}` | **Built** |
| Rosters | `GET/POST /sites/{id}/posts`, `PATCH /posts/{id}`, `GET/POST /shift-patterns`, `PATCH /shift-patterns/{id}`; employee create/update take `postId` and `shiftPatternId` | **Built** |
| Devices (ADMIN) | `GET/POST /devices`, `GET/PATCH /devices/{id}`, `POST /devices/{id}/rotate-secret` | In the contract (Phase 2) |
| Ingest (device-signed) | `POST /ingest/punches`, `POST /ingest/heartbeat` | In the contract (Phase 2) |
| Attendance | `GET /attendance/segments`, `GET /attendance/exceptions`, `GET /attendance/exceptions/{id}`, `POST /attendance/exceptions/{id}/resolve` | In the contract (Phase 2) — see [12 · Attendance design](12-attendance-design.md) |
| Kiosk (device-signed) | `POST /kiosk/identify`, `/kiosk/confirm`, `/kiosk/not-me`, `/kiosk/fingerprint-options`, `/kiosk/assisted-punches`; ADMIN token **and** signature: `POST /kiosk/consents`, `/kiosk/face-enrollments`, `/kiosk/passkey-options`, `/kiosk/passkeys` | In the contract (Phase 3) — see [13 · Biometrics design](13-biometrics-design.md) |
| Biometrics | `GET /biometrics/consent-text`, `GET /employees/{id}/biometrics`, `POST /employees/{id}/biometrics/revoke`, `/biometric-exemption`, `/biometric-exemption/review`, `/biometric-consents/withdraw`, `GET /biometric-collisions`, `POST /biometric-collisions/{credentialId}/resolve` | In the contract (Phase 3) |
| Live attendance | `GET /attendance/punches` (live clock-ins board), `GET /attendance/clock-in-attempts` (ADMIN) | In the contract (Phase 3) |
| Payroll | periods, runs (calculate, submit, approve, reject, mark paid), lines, payslips and their PDFs, bank export, statutory summary, tax tables, pay terms, payment details | **In the contract** (Phase 4) |
| Detection | alerts, resolution, rules, sweep | Phase 5 |
| Reports | attendance and payroll summaries, CSV and PDF export | Phase 6 |

## Security notes for specific endpoints

- **`GET /health`** is public, so it reports only status, time and database state. The API version and environment will come from an admin-only endpoint in Phase 1.
- **Sign-in endpoints** (Phase 1) follow the two-factor and session rules in [Security and review gates](06-security-and-review-gates.md#security-controls): short-lived one-time tokens, a limit on wrong codes, rotating refresh cookies with reuse detection, and an `Origin` check on refresh and logout. Phase 3 adds an `Origin` rule to the sign-in steps themselves: dashboard or kiosk, decided by `CORS_ORIGINS` and `KIOSK_ORIGINS`.
- **`POST /ingest/punches`** (Phase 2) authenticates each device with its own secret (an HMAC signature), not a user token. It is rate-limited per device, limits body size, and ignores repeated punches.
- **Kiosk endpoints** (Phase 3) accept only `FACE_KIOSK` devices, and `/ingest/punches` refuses them. The kiosk's enrollment endpoints need an ADMIN's access token **and** the kiosk's signature. A sign-in from a kiosk address (`KIOSK_ORIGINS`) gets no refresh cookie and a token that works only for the kiosk screens; the kiosk's ADMIN routes accept only that token. No answer ever contains a face template, and no kiosk answer contains a match score.
- **Approval endpoints** (Phase 4) enforce that the maker is not the checker inside the service, not only in the dashboard.
- **Guard accounts** can read only their own attendance and payslips. Tests must prove that guard A cannot read guard B's records (OWASP API Security risk number 1).
- **Records a user may not see return 404, not 403,** so nobody can discover which IDs exist.

Related: [System architecture](03-system-architecture.md) · [Security and review gates](06-security-and-review-gates.md)
