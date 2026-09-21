import type { UserRole } from '@samtec/contracts';

// `Record<UserRole, …>` makes TypeScript fail the build if the contract ever
// gains a role that has no label here.
export const roleLabels: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  HR_PAYROLL: 'HR & payroll',
  SUPERVISOR: 'Supervisor',
  GUARD: 'Guard',
};

/**
 * Which roles may open each page. Copied from the `@Roles(...)` rules on the
 * API's controllers, so the sidebar never offers a page the API would refuse
 * with 403. The API stays the real gatekeeper; this only keeps the dashboard
 * honest about it.
 */
export const pageRoles = {
  /** `GET /employees` — the list. A guard may still open their own record. */
  employees: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** `GET /sites` — the list. */
  sites: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** Creating, changing or terminating an employee (`POST`/`PATCH /employees…`). */
  employeeChanges: ['ADMIN', 'HR_PAYROLL'],
} as const satisfies Record<string, readonly UserRole[]>;

/** True when `role` is one of `allowed`. */
export function roleAllowed(allowed: readonly UserRole[], role: UserRole): boolean {
  return allowed.includes(role);
}
