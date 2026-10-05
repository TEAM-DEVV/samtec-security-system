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
- A site goes `INACTIVE` only once nobody is posted there and nothing another module owns still needs it. This module reads no other module's table to find that out: other modules register a check in `SiteDeactivationChecks` when they start (the attendance module does, for a switched-on device), and `SitesService.update` runs every check inside the same transaction as the change.
