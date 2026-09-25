import { describe, expect, it } from 'vitest';
import { pageRoles, roleAllowed, roleNeedsEmployee } from './roles';

// These pin the API's role rules. If a rule changes on purpose, change it
// here and in the API in the same pull request.
describe('pageRoles', () => {
  it('keeps user accounts, devices and every biometric decision with administrators only', () => {
    expect(pageRoles.users).toEqual(['ADMIN']);
    expect(pageRoles.devices).toEqual(['ADMIN']);
    expect(pageRoles.biometricChanges).toEqual(['ADMIN']);
    expect(pageRoles.duplicateFaces).toEqual(['ADMIN']);
    expect(pageRoles.kioskAttempts).toEqual(['ADMIN']);
  });

  it('lets HR read attendance and the queue but never resolve an exception', () => {
    expect(roleAllowed(pageRoles.attendance, 'HR_PAYROLL')).toBe(true);
    expect(roleAllowed(pageRoles.exceptions, 'HR_PAYROLL')).toBe(true);
    expect(roleAllowed(pageRoles.resolveExceptions, 'HR_PAYROLL')).toBe(false);
  });

  /**
   * A guard's own payslips are the one exception, and the only one.
   *
   * Every other page in the dashboard is company-wide, and a guard has no
   * business on any of them. `payslips` is different because the API scopes
   * that list to the caller rather than refusing them: a guard asking for the
   * list gets their own, and asking for somebody else's gets 404 and never 403,
   * so nobody can learn which payslips exist.
   *
   * If a second page ever needs a guard, add it to this list **and** say in the
   * pull request why the API can scope it safely. The loop below is what stops
   * one being added by accident.
   */
  const pagesAGuardMayOpen = ['payslips'];

  it('keeps a guard out of every company-wide page', () => {
    for (const [page, allowed] of Object.entries(pageRoles)) {
      if (pagesAGuardMayOpen.includes(page)) {
        continue;
      }
      expect(roleAllowed(allowed, 'GUARD'), `${page} must not admit a guard`).toBe(false);
    }
  });

  it('lets a guard open their own payslips, and nothing else in payroll', () => {
    expect(roleAllowed(pageRoles.payslips, 'GUARD')).toBe(true);
    expect(roleAllowed(pageRoles.payroll, 'GUARD')).toBe(false);
    expect(roleAllowed(pageRoles.payrollChanges, 'GUARD')).toBe(false);
    expect(roleAllowed(pageRoles.payrollApproval, 'GUARD')).toBe(false);
  });

  it('keeps a supervisor out of payroll entirely: they run the roster, never the money', () => {
    expect(roleAllowed(pageRoles.payroll, 'SUPERVISOR')).toBe(false);
    expect(roleAllowed(pageRoles.payslips, 'SUPERVISOR')).toBe(false);
    expect(roleAllowed(pageRoles.payrollApproval, 'SUPERVISOR')).toBe(false);
  });

  it('lets a payroll officer prepare a run but never approve one', () => {
    // The whole reason Phase 4 exists: the maker is never the checker.
    expect(roleAllowed(pageRoles.payrollChanges, 'HR_PAYROLL')).toBe(true);
    expect(roleAllowed(pageRoles.payrollApproval, 'HR_PAYROLL')).toBe(false);
    expect(pageRoles.payrollApproval).toEqual(['ADMIN']);
  });
});

describe('roleNeedsEmployee', () => {
  it('is true only for the roles that are on the roster', () => {
    expect(roleNeedsEmployee('SUPERVISOR')).toBe(true);
    expect(roleNeedsEmployee('GUARD')).toBe(true);
    expect(roleNeedsEmployee('ADMIN')).toBe(false);
    expect(roleNeedsEmployee('HR_PAYROLL')).toBe(false);
  });
});
