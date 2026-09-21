import { afterEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { resetMockUsers } from './users';

// This file resets its own mock store, so it needs no change to test/setup.ts.
afterEach(() => resetMockUsers());

const GUARD_EMPLOYEE_ID = '01927c3e-5a4b-7c8d-9e0f-000000000001';

/** The mock Users API follows the same rules as the real one. */
describe('mock users API', () => {
  it('creates an account that waits for a password, with a one-time link', async () => {
    const { data, response } = await fetchClient.POST('/users', {
      body: {
        email: 'New.Guard@samtec.example',
        fullName: 'New Guard',
        role: 'GUARD',
        employeeId: GUARD_EMPLOYEE_ID,
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
    const { data: list } = await fetchClient.GET('/users');
    const hr = list?.items.find((account) => account.role === 'HR_PAYROLL');
    const userId = hr?.id ?? '';

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

  it('answers a wrong current password with 400, never 401', async () => {
    const { response, error } = await fetchClient.POST('/auth/change-password', {
      body: { currentPassword: 'not it', newPassword: 'a long enough password' },
    });
    expect(response.status).toBe(400);
    expect(error?.errors?.[0]?.path).toBe('currentPassword');
  });
});
