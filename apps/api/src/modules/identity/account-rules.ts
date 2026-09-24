import type { UserAccountStatus } from '@samtec/contracts';
import type { User, UserRole } from '../../generated/prisma/client.js';

/**
 * The account rules, as small pure functions so each one can be tested and
 * explained on its own. Every place that decides "may this account be used?"
 * calls `mayUseAccount`, so the answer is the same at sign-in, at refresh,
 * and on every request.
 */

/** Only these roles work at a site, so only they are linked to an employee. */
export function needsEmployeeLink(role: UserRole): boolean {
  return role === 'SUPERVISOR' || role === 'GUARD';
}

/**
 * Why this role and employee link may not go together, or undefined when they
 * fit. SUPERVISOR and GUARD accounts see data through their employee record;
 * office accounts are never linked, so terminating an employee can never
 * switch off an administrator. (A database CHECK enforces the same rule.)
 */
export function employeeLinkProblem(role: UserRole, employeeId: string | null): string | undefined {
  if (needsEmployeeLink(role) && employeeId === null) {
    return 'SUPERVISOR and GUARD accounts must be linked to an employee.';
  }
  if (!needsEmployeeLink(role) && employeeId !== null) {
    return 'ADMIN and HR_PAYROLL accounts are not linked to an employee.';
  }
  return undefined;
}

/** These roles handle pay and personal data, so they must use two-factor authentication. */
export function needsTwoFactor(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'HR_PAYROLL';
}

/**
 * True while an ADMIN account made, promoted, reset or switched back on by one
 * administrator waits for a second to confirm it (docs/plan/06, "Two
 * administrators"). An ADMIN with no request recorded at all was made
 * directly in the database — the seed or the setup script — and does not wait.
 */
export function awaitsAdminConfirmation(
  account: Pick<User, 'role' | 'adminRequestedAt' | 'adminConfirmedAt'>,
): boolean {
  return (
    account.role === 'ADMIN' &&
    account.adminRequestedAt !== null &&
    account.adminConfirmedAt === null
  );
}

type AccountFacts = Pick<
  User,
  | 'isActive'
  | 'passwordHash'
  | 'role'
  | 'twoFactorEnabledAt'
  | 'adminRequestedAt'
  | 'adminConfirmedAt'
>;

/**
 * True when the account may be used right now: it is switched on, its owner
 * has chosen a password, an ADMIN account is not waiting for a second
 * administrator, and — for ADMIN and HR_PAYROLL — two-factor authentication
 * is on. The last check is a backstop: even if a role change and a refresh
 * happened in the same instant, an ADMIN token without a second factor can
 * never be used.
 */
export function mayUseAccount(account: AccountFacts): boolean {
  if (!account.isActive || account.passwordHash === null || awaitsAdminConfirmation(account)) {
    return false;
  }
  return !needsTwoFactor(account.role) || account.twoFactorEnabledAt !== null;
}

/** The status the contract shows administrators. */
export function accountStatus(
  account: Pick<
    User,
    'isActive' | 'passwordHash' | 'role' | 'adminRequestedAt' | 'adminConfirmedAt'
  >,
): UserAccountStatus {
  if (!account.isActive) {
    return 'DEACTIVATED';
  }
  // Before the password: confirming is the other administrators' next step,
  // and until it happens the password would open nothing anyway.
  if (awaitsAdminConfirmation(account)) {
    return 'AWAITING_CONFIRMATION';
  }
  return account.passwordHash === null ? 'AWAITING_PASSWORD' : 'ACTIVE';
}
