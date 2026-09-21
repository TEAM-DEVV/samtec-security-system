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

- **Base path:** `/api/v1`. JSON only. IDs are UUID version 7.
- **Money:** integer pesewas, with field names ending in `Pesewas`.
- **Time:** timestamps in UTC (ISO 8601); calendar dates as `YYYY-MM-DD`.
- **Errors:** Problem Details (RFC 9457) with `type`, `title`, `status`, `detail`, `traceId`, and `errors` for validation. Stack traces never leave the server.
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
| Enrollment | `POST /employees/{id}/biometrics`, duplicate check, activation | Phase 3 |
| Devices | device registry, heartbeat, `POST /ingest/punches` | Phase 2 |
| Attendance | daily attendance, exceptions and their resolution | Phase 2 |
| Payroll | periods, runs, submit, approve, payslips, bank export | Phase 4 |
| Detection | alerts, resolution, rules, sweep | Phase 5 |
| Reports | attendance and payroll summaries, CSV and PDF export | Phase 6 |

## Security notes for specific endpoints

- **`GET /health`** is public, so it reports only status, time and database state. The API version and environment will come from an admin-only endpoint in Phase 1.
- **Sign-in endpoints** (Phase 1) follow the two-factor and session rules in [Security and review gates](06-security-and-review-gates.md#security-controls): short-lived one-time tokens, a limit on wrong codes, rotating refresh cookies with reuse detection, and an `Origin` check on refresh and logout.
- **`POST /ingest/punches`** (Phase 2) authenticates each device with its own secret (an HMAC signature), not a user token. It is rate-limited per device, limits body size, and ignores repeated punches.
- **Approval endpoints** (Phase 4) enforce that the maker is not the checker inside the service, not only in the dashboard.
- **Guard accounts** can read only their own attendance and payslips. Tests must prove that guard A cannot read guard B's records (OWASP API Security risk number 1).
- **Records a user may not see return 404, not 403,** so nobody can discover which IDs exist.

Related: [System architecture](03-system-architecture.md) · [Security and review gates](06-security-and-review-gates.md)
