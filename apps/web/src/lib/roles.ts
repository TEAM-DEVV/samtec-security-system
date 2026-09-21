import type { UserRole } from '@samtec/contracts';

// `Record<UserRole, …>` makes TypeScript fail the build if the contract ever
// gains a role that has no label here.
export const roleLabels: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  HR_PAYROLL: 'HR & payroll',
  SUPERVISOR: 'Supervisor',
  GUARD: 'Guard',
};
