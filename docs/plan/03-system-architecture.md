# 03 · System architecture

SAMTEC is a **modular monolith**: one API application that is deployed as a single unit, with strict module boundaries inside it.

## Layers

The top layer is what people use; the bottom layer is the ground truth.

```
┌─────────────────────────────────────────────────────────────────────┐
│ L5 EXPERIENCE   apps/web: admin dashboard (role-based)              │
│                 apps/kiosk: face clock-in page (Phase 3)            │
├─────────────────────────────────────────────────────────────────────┤
│ L4 EDGE         HTTPS · Helmet headers · CORS · request IDs         │
│                 sign-in guard · role guard · rate limits (Phase 1)  │
├─────────────────────────────────────────────────────────────────────┤
│ L3 DOMAIN       identity │ workforce │ attendance                   │
│   MODULES       payroll  │ detection │ reporting                    │
├─────────────────────────────────────────────────────────────────────┤
│ L2 INTEGRATION  BiometricProvider: mock │ ZKTeco │ face kiosk        │
│                 device sync: ADMS push and scheduled pull           │
├─────────────────────────────────────────────────────────────────────┤
│ L1 DATA         PostgreSQL through Prisma · append-only audit log   │
│                 encrypted biometric template vault                  │
└─────────────────────────────────────────────────────────────────────┘
```

## How the layers map to the code

| Layer | Where it lives |
|---|---|
| L5 Experience | `apps/web/src/pages`, `apps/web/src/components` |
| Contract between L5 and L4 | `packages/contracts/openapi.yaml` |
| L4 Edge | `apps/api/src/app.setup.ts`, `apps/api/src/common/` (guards arrive in Phase 1) |
| L3 Domain modules | `apps/api/src/modules/<module>/` |
| L2 Integration | `apps/api/src/modules/attendance/` providers (Phases 2 and 3) |
| L1 Data | `apps/api/prisma/schema.prisma`, `apps/api/src/database/` |

## Domain modules (L3)

| Module | Responsibility | Key rule |
|---|---|---|
| `identity` | Users, roles, sessions, two-factor authentication, audit log | Every change to important data writes an audit row |
| `workforce` | Employees, sites, posts, shift rosters, assignments | An employee is not active until biometrics are enrolled and the duplicate check passed |
| `attendance` | Punch ingestion, pairing clock-ins with clock-outs, hours, exceptions | Punches are append-only; corrections are new rows pointing to the old ones |
| `payroll` | Periods, runs, lines, PAYE and SSNIT, approvals, payslips | Runs copy their inputs; locked runs never change. See [Payroll engine](09-payroll-engine-ghana.md) |
| `detection` | Rules engine, alerts, review queue | Rules only read data; people resolve alerts. See [Ghost detection engine](08-ghost-detection-engine.md) |
| `reporting` | Summaries, CSV and PDF exports | Read-only over the other modules' services |

**The boundary rule.** Modules talk to each other through their services, never through each other's tables. The Prisma schema is shared, but only the owning module writes to a table. This one rule is what keeps the monolith modular.

## Life of a request in the API

What happens when the dashboard calls `GET /api/v1/health`:

1. **Request ID middleware** gives the request an ID and returns it in the `X-Request-ID` header.
2. **Helmet** adds secure HTTP headers.
3. **CORS** checks that the request comes from an allowed website.
4. **Body parser** reads a JSON body of up to 100 kB (a GET has none). A bigger body is refused with `413`.
5. **Routing** finds `HealthController.getHealth`.
6. **Validation** runs Zod schemas declared on the route (none on `/health`).
7. **Controller** calls `HealthService.check()`.
8. **Service** asks `PrismaService` whether the database answers. It gives up after 3 seconds, and reuses the answer for 5 seconds.
9. **Response** is JSON shaped exactly like `HealthResponse` in the contract.
10. **If anything throws,** `ProblemDetailsFilter` turns it into a Problem Details error that includes the request ID as `traceId`. It logs one line for a client error (4xx), and the error type and stack for a server error (5xx). It never logs request bodies, query strings or error messages, because those can contain personal data.

## The golden path (the whole business flow)

```
guard's finger or face
  → the device matches it on board (1:N identification)
  → punch event {device_id, device_event_id, employee reference, time}
  → pushed by the device (ADMS) or pulled on a schedule → attendance.ingest
      · idempotency: unique (device_id, device_event_id), so a repeated punch is ignored
      · both the device time and the server receive time are stored
  → pairing: clock-in + clock-out → work segments → daily hours
  → exception queue: missing clock-out, shift across midnight, overlapping segments
  → payroll run at period close → lines copied → maker submits → checker approves and locks
  → payslips and bank export
  (the detection engine flags anomalies all along the way)
```

## Environments

| Environment | Purpose | Data |
|---|---|---|
| Local | Development. Mock biometric provider only. | Seeded fictional company: 50 employees across 5 sites |
| Demo | Client presentation and final year defense | The same fictional seed, plus planted ghost workers (Phase 5), hosted online |
| Pilot | Only if the client signs | Real data, only after the Phase 7 security gate passes |

## Hosting: one site for the dashboard and the API

The refresh token cookie uses `SameSite=Strict`, so a browser only sends it when the dashboard and the API belong to the **same site**. A dashboard on `samtec.vercel.app` calling an API on `samtec.up.railway.app` would not work: those are two different sites, and signing in would silently fail.

For the hosted demo (Phase 8), use one of these, in order of preference:

1. **One domain, two subdomains.** The dashboard on `app.<domain>` and the API on `api.<domain>`. Subdomains of one domain count as the same site. Set `CORS_ORIGINS=https://app.<domain>` on the API.
2. **A rewrite on the dashboard's host.** Vercel forwards `/api/v1/*` to the API, so the browser only ever talks to one address. Set `VITE_API_BASE_URL=/api/v1`.

Local development already works, because `localhost:5173` and `localhost:3000` count as the same site.

## Rules that hold everywhere

These are enforced in code and checked in every review.

1. All money is stored as **integer pesewas**. The word "float" near money fails review.
2. All timestamps are stored in **UTC**. Showing Africa/Accra time is the dashboard's job.
3. People are never hard-deleted; their `status` changes, so history survives.
4. Every table has `created_at` and `updated_at`. The audit log (Phase 1) is append-only.
5. IDs are **UUID version 7**: sortable by time and impossible to guess from a URL.
6. Every table has **row-level security** switched on in the migration that creates it, so only the API can read it. See [Data model](04-data-model.md#row-level-security-on-every-table).

Related: [Data model](04-data-model.md) · [API contract](05-api-contract.md) · [Biometric integration](10-biometric-integration.md)
