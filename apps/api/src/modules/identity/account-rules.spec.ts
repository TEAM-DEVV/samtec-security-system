import { describe, expect, it } from 'vitest';
import {
  accountStatus,
  awaitsAdminConfirmation,
  employeeLinkProblem,
  mayUseAccount,
} from './account-rules.js';

const usable = {
  isActive: true,
  passwordHash: 'scrypt$…',
  role: 'SUPERVISOR' as const,
  twoFactorEnabledAt: null,
  adminRequestedAt: null,
  adminConfirmedAt: null,
};

/** A usable administrator, before any Phase 7 hold. */
const admin = { ...usable, role: 'ADMIN' as const, twoFactorEnabledAt: new Date() };
const asked = new Date('2026-09-24T10:00:00Z');

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

  it('refuses an ADMIN waiting for a second administrator, password and two-factor or not', () => {
    expect(mayUseAccount({ ...admin, adminRequestedAt: asked })).toBe(false);
    expect(mayUseAccount({ ...admin, adminRequestedAt: asked, adminConfirmedAt: asked })).toBe(
      true,
    );
    // Made in the database (seed, setup script): nothing was asked, so nothing waits.
    expect(mayUseAccount(admin)).toBe(true);
  });
});

describe('awaitsAdminConfirmation', () => {
  it('holds only an ADMIN with a request and no confirmation', () => {
    expect(awaitsAdminConfirmation({ ...admin, adminRequestedAt: asked })).toBe(true);
    expect(
      awaitsAdminConfirmation({ ...admin, adminRequestedAt: asked, adminConfirmedAt: asked }),
    ).toBe(false);
    expect(awaitsAdminConfirmation(admin)).toBe(false);
    expect(awaitsAdminConfirmation({ ...usable, adminRequestedAt: asked })).toBe(false);
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
  it('names the four states the dashboard shows', () => {
    expect(accountStatus(usable)).toBe('ACTIVE');
    expect(accountStatus({ ...usable, passwordHash: null })).toBe('AWAITING_PASSWORD');
    expect(accountStatus({ ...usable, isActive: false })).toBe('DEACTIVATED');
    expect(accountStatus({ ...usable, isActive: false, passwordHash: null })).toBe('DEACTIVATED');
  });

  it('puts a held ADMIN before its password: confirming comes next', () => {
    expect(accountStatus({ ...admin, passwordHash: null, adminRequestedAt: asked })).toBe(
      'AWAITING_CONFIRMATION',
    );
    expect(accountStatus({ ...admin, isActive: false, adminRequestedAt: asked })).toBe(
      'DEACTIVATED',
    );
  });
});
