import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { restoreSession, signOut } from '@/lib/auth';
import { env } from '@/lib/env';
import { getSession } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { server } from '@/mocks/node';
import { signInForTests } from '@/test/session';

describe('restoreSession', () => {
  it('returns false and keeps no session when there is no refresh cookie', async () => {
    expect(await restoreSession()).toBe(false);
    expect(getSession()).toBeNull();
  });

  it('brings the user back from the refresh cookie alone', async () => {
    await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });

    expect(await restoreSession()).toBe(true);
    expect(getSession()?.user.email).toBe('supervisor@samtec.example');
  });
});

describe('signOut', () => {
  it('forgets the session on both sides', async () => {
    await signInForTests();

    await signOut();

    expect(getSession()).toBeNull();
    expect((await fetchClient.POST('/auth/refresh')).response.status).toBe(401);
  });

  it('still forgets the session here when the API cannot be reached', async () => {
    await signInForTests();
    server.use(http.post(`${env.apiBaseUrl}/auth/logout`, () => HttpResponse.error()));

    await expect(signOut()).resolves.toBeUndefined();

    expect(getSession()).toBeNull();
  });
});
