# workforce module (Phase 1)

**Purpose:** the people the company employs, and where they work.

**Owns these tables:** `companies`, `employees`, `sites` and `site_assignments` (created in Phase 0), plus `posts` and `shift_patterns` (added in Phase 1).

**Endpoints (see `packages/contracts/openapi.yaml`):** `GET/POST /employees`, `GET/PATCH /employees/{employeeId}`, `POST /employees/{employeeId}/terminate`, `GET /sites`, `GET /sites/{siteId}`.

## Rules that must hold

- Employees are never deleted. Leaving the company sets `status` to `TERMINATED`.
- A Ghana Card number can belong to only one employee (a database unique constraint).
- The Ghana Card number cannot be changed through `PATCH`; identity corrections need an audited admin process.
- List responses leave out sensitive identity fields (data minimisation).
- Supervisors only see employees and sites assigned to them. Records they may not see return `404`.
- Moving a guard ends the current site assignment and starts a new one, so history is kept.
