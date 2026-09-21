# Feature modules

Each folder here is one **domain module**: a self-contained part of the business with its own controllers, services and database tables. This is how the architecture in `docs/plan/03-system-architecture.md` appears in the code.

| Module | What it owns | Built in |
|---|---|---|
| `identity/` | User accounts and their management, roles, sign-in, two-factor authentication, audit log | Phase 1 |
| `workforce/` | Employees, sites, posts, shift patterns, site assignments | Phase 1 |
| `attendance/` | Biometric devices, punches, work segments, attendance exceptions | Phases 2 and 3 |
| `payroll/` | Payroll periods and runs, PAYE and SSNIT, payslips | Phase 4 |
| `detection/` | Ghost-worker detection rules and alerts | Phase 5 |
| `reporting/` | Read-only reports and exports | Phase 6 |

The folders only hold a README until their phase starts. Health checks, configuration and the database client live outside `modules/` because every module uses them.

## The rule that keeps this clean

A module **writes only to its own tables**. If `payroll` needs employee data, it calls a method on the `workforce` service. It never queries or updates the `employees` table itself.

## Shape of a module

```
workforce/
  workforce.module.ts          wires the pieces together
  employees.controller.ts      HTTP layer: routes, validation, status codes (keep it thin)
  employees.service.ts         business rules and database access
  employees.service.spec.ts    unit tests for the service
  employees.schemas.ts         Zod schemas for requests, matching the API contract
```

See `docs/guides/04-backend-guide.md` for a step-by-step example of adding an endpoint.
