import { beforeEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { clearSession } from '@/lib/session';
import { signInForTests } from '@/test/session';
import { mockAccounts } from '../data/accounts';
import { mockEmployees } from '../data/employees';

/** An employee who has not left and has no sign-in account yet, whatever the mock data holds. */
const linkable = mockEmployees.find(
  (employee) =>
    employee.status !== 'TERMINATED' &&
    !mockAccounts.some((account) => account.employeeId === employee.id),
);
const LINKABLE_EMPLOYEE_ID = linkable?.id ?? '';

/** The signed-in administrator's own account, and someone else's. */
const ADMIN_ID = mockAccounts.find((account) => account.role === 'ADMIN')?.id ?? '';
const HR_ID = mockAccounts.find((account) => account.role === 'HR_PAYROLL')?.id ?? '';

/** The mock Users API follows the same rules as the real one. */
describe('mock users API', () => {
  // Every Users route needs an ADMIN. test/setup.ts resets the store and the session afterwards.
  beforeEach(() => signInForTests('admin@samtec.example'));

  it('refuses anyone who is not a signed-in administrator', async () => {
    const asAdmin = await fetchClient.GET('/users');
    expect(asAdmin.response.status).toBe(200);

    clearSession();
    const signedOut = await fetchClient.GET('/users');
    expect(signedOut.response.status).toBe(401);

    await signInForTests('supervisor@samtec.example');
    const asSupervisor = await fetchClient.GET('/users');
    expect(asSupervisor.response.status).toBe(403);
  });

  it('creates an account that waits for a password, with a one-time link', async () => {
    const { data, response } = await fetchClient.POST('/users', {
      body: {
        email: 'New.Guard@samtec.example',
        fullName: 'New Guard',
        role: 'GUARD',
        employeeId: LINKABLE_EMPLOYEE_ID,
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(data?.user).toMatchObject({
      email: 'new.guard@samtec.example',
      status: 'AWAITING_PASSWORD',
    });

    const set = await fetchClient.POST('/auth/set-password', {
      body: { token: data?.passwordSetup.token ?? '', newPassword: 'a long enough password' },
    });
    expect(set.response.status).toBe(204);
    const again = await fetchClient.POST('/auth/set-password', {
      body: { token: data?.passwordSetup.token ?? '', newPassword: 'a long enough password' },
    });
    expect(again.response.status).toBe(400);
  });

  it('enforces the employee link and one account per email', async () => {
    const unlinked = await fetchClient.POST('/users', {
      body: { email: 'g@samtec.example', fullName: 'No Link', role: 'GUARD' },
    });
    expect(unlinked.response.status).toBe(400);
    expect(unlinked.error?.errors?.[0]?.path).toBe('employeeId');

    const taken = await fetchClient.POST('/users', {
      body: { email: 'HR@samtec.example', fullName: 'Same Email', role: 'HR_PAYROLL' },
    });
    expect(taken.response.status).toBe(409);
  });

  it('switches an account off and on, and resets sign-in with a fresh link', async () => {
    const userId = HR_ID;

    const off = await fetchClient.POST('/users/{userId}/deactivate', {
      params: { path: { userId } },
    });
    expect(off.data?.status).toBe('DEACTIVATED');
    const reset = await fetchClient.POST('/users/{userId}/reset-sign-in', {
      params: { path: { userId } },
    });
    expect(reset.response.status).toBe(409); // Switched off: reactivate first.

    await fetchClient.POST('/users/{userId}/reactivate', { params: { path: { userId } } });
    const fresh = await fetchClient.POST('/users/{userId}/reset-sign-in', {
      params: { path: { userId } },
    });
    expect(fresh.data?.user).toMatchObject({
      status: 'AWAITING_PASSWORD',
      twoFactorEnabled: false,
    });
    expect(fresh.data?.passwordSetup.token).toBeTruthy();
  });

  it('lets an administrator rename their own account, and nothing else', async () => {
    const renamed = await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId: ADMIN_ID } },
      body: { fullName: 'Efua A. Mensah' },
    });
    expect(renamed.data?.fullName).toBe('Efua A. Mensah');

    const demoted = await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId: ADMIN_ID } },
      body: { role: 'GUARD' },
    });
    expect(demoted.response.status).toBe(409);

    const off = await fetchClient.POST('/users/{userId}/deactivate', {
      params: { path: { userId: ADMIN_ID } },
    });
    expect(off.response.status).toBe(409);
    const reset = await fetchClient.POST('/users/{userId}/reset-sign-in', {
      params: { path: { userId: ADMIN_ID } },
    });
    expect(reset.response.status).toBe(409);
  });

  it('checks the email and name on update exactly as on create', async () => {
    const userId = HR_ID;

    const badEmail = await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId } },
      body: { email: 'not-an-email' },
    });
    const emptyName = await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId } },
      body: { fullName: '' },
    });
    const longName = await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId } },
      body: { fullName: 'x'.repeat(121) },
    });
    expect(badEmail.error?.errors?.[0]?.path).toBe('email');
    expect(emptyName.error?.errors?.[0]?.path).toBe('fullName');
    expect(longName.response.status).toBe(400);
  });

  it('answers a wrong current password with 400, never 401', async () => {
    const { response, error } = await fetchClient.POST('/auth/change-password', {
      body: { currentPassword: 'not it', newPassword: 'a long enough password' },
    });
    expect(response.status).toBe(400);
    expect(error?.errors?.[0]?.path).toBe('currentPassword');
  });
});
