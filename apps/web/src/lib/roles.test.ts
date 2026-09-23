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

  it('keeps a guard out of every company-wide page', () => {
    for (const allowed of Object.values(pageRoles)) {
      expect(roleAllowed(allowed, 'GUARD')).toBe(false);
    }
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
