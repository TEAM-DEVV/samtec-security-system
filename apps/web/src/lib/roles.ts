import type { UserRole } from '@samtec/contracts';

// `Record<UserRole, …>` makes TypeScript fail the build if the contract ever
// gains a role that has no label here.
export const roleLabels: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  HR_PAYROLL: 'HR & payroll',
  SUPERVISOR: 'Supervisor',
  GUARD: 'Guard',
};

/** One plain sentence per role, based on the contract's `UserRole` description, for the overview page. */
export const roleDescriptions: Record<UserRole, string> = {
  ADMIN: 'Full access, including user management and approving payroll runs.',
  HR_PAYROLL:
    'Manages employees and prepares payroll runs, but can never approve a run they prepared.',
  SUPERVISOR: 'Manages attendance and rosters for the sites they are posted to.',
  GUARD: 'Sees only their own record, attendance and payslips.',
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
  /** `GET /users` and every other Users operation: sign-in accounts are an administrator's job. */
  users: ['ADMIN'],
  /** `GET /attendance/segments` for the company or a site. A guard sees only themselves, on "My attendance". */
  attendance: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** `GET /attendance/exceptions`: the queue. HR reads it; ADMIN and SUPERVISOR also resolve. */
  exceptions: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** Every Devices operation. */
  devices: ['ADMIN'],
  /** `POST /attendance/exceptions/{id}/resolve`. The API also refuses your own attendance and other sites. */
  resolveExceptions: ['ADMIN', 'SUPERVISOR'],
  /** `GET /attendance/punches`: the live board. A supervisor sees their own sites only. */
  liveBoard: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** `GET /employees/{id}/biometrics`: the Biometrics panel on an employee's page. */
  biometrics: ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR'],
  /** Every biometric change: wipe a face, record a withdrawal, ask for or decide an exemption. */
  biometricChanges: ['ADMIN'],
  /** `GET /biometric-collisions` and deciding one: the duplicate-enrollment queue. */
  duplicateFaces: ['ADMIN'],
  /** `GET /attendance/clock-in-attempts`: every attempt at the kiosks. */
  kioskAttempts: ['ADMIN'],
} as const satisfies Record<string, readonly UserRole[]>;

/** SUPERVISOR and GUARD accounts belong to an employee; ADMIN and HR_PAYROLL do not (the contract's `createUser` rule). */
export function roleNeedsEmployee(role: UserRole): boolean {
  return role === 'SUPERVISOR' || role === 'GUARD';
}

/** True when `role` is one of `allowed`. */
export function roleAllowed(allowed: readonly UserRole[], role: UserRole): boolean {
  return allowed.includes(role);
}
