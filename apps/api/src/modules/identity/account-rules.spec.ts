import { describe, expect, it } from 'vitest';
import { accountStatus, employeeLinkProblem, mayUseAccount } from './account-rules.js';

const usable = {
  isActive: true,
  passwordHash: 'scrypt$…',
  role: 'SUPERVISOR' as const,
  twoFactorEnabledAt: null,
};

describe('mayUseAccount', () => {
  it('allows an active account whose owner chose a password', () => {
    expect(mayUseAccount(usable)).toBe(true);
  });

  it('refuses a switched-off account and one still waiting for its password', () => {
    expect(mayUseAccount({ ...usable, isActive: false })).toBe(false);
    expect(mayUseAccount({ ...usable, passwordHash: null })).toBe(false);
  });

  it('refuses ADMIN and HR_PAYROLL without two-factor, but not field roles', () => {
    expect(mayUseAccount({ ...usable, role: 'ADMIN' })).toBe(false);
    expect(mayUseAccount({ ...usable, role: 'HR_PAYROLL' })).toBe(false);
    expect(mayUseAccount({ ...usable, role: 'ADMIN', twoFactorEnabledAt: new Date() })).toBe(true);
    expect(mayUseAccount({ ...usable, role: 'GUARD' })).toBe(true);
  });
});

describe('employeeLinkProblem', () => {
  it('requires a link for SUPERVISOR and GUARD', () => {
    expect(employeeLinkProblem('SUPERVISOR', null)).toBeDefined();
    expect(employeeLinkProblem('GUARD', null)).toBeDefined();
    expect(employeeLinkProblem('GUARD', 'some-employee-id')).toBeUndefined();
  });

  it('forbids a link for ADMIN and HR_PAYROLL, so a termination can never reach them', () => {
    expect(employeeLinkProblem('ADMIN', 'some-employee-id')).toBeDefined();
    expect(employeeLinkProblem('HR_PAYROLL', 'some-employee-id')).toBeDefined();
    expect(employeeLinkProblem('ADMIN', null)).toBeUndefined();
  });
});

describe('accountStatus', () => {
  it('names the three states the dashboard shows', () => {
    expect(accountStatus({ isActive: true, passwordHash: 'x' })).toBe('ACTIVE');
    expect(accountStatus({ isActive: true, passwordHash: null })).toBe('AWAITING_PASSWORD');
    expect(accountStatus({ isActive: false, passwordHash: 'x' })).toBe('DEACTIVATED');
    expect(accountStatus({ isActive: false, passwordHash: null })).toBe('DEACTIVATED');
  });
});
