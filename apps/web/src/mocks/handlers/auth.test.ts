import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { MOCK_PASSWORD, MOCK_TWO_FACTOR_CODE } from '../data/users';

/** These tests prove the mock sign-in flows follow the contract, so pages built on them will fit the real API. */
describe('mock auth API', () => {
  it('signs a supervisor straight in', async () => {
    const { data } = await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });

    expect(data?.status).toBe('AUTHENTICATED');
  });

  it('refuses a wrong password without saying which part was wrong', async () => {
    const { error, response } = await fetchClient.POST('/auth/login', {
      body: { email: 'admin@samtec.example', password: 'not-the-password' },
    });

    expect(response.status).toBe(401);
    expect(error?.detail).toBe('Email or password is incorrect.');
  });

  it('locks an email after five wrong passwords, even for the right one', async () => {
    const wrongPassword = { email: 'supervisor@samtec.example', password: 'not-the-password' };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { response } = await fetchClient.POST('/auth/login', { body: wrongPassword });
      expect(response.status).toBe(401);
    }

    const { error, response } = await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('900');
    expect(error?.detail).toBe('Too many attempts. Try again in 900 seconds.');
  });

  it('asks an admin for a two-factor code, then signs them in', async () => {
    const login = await fetchClient.POST('/auth/login', {
      body: { email: 'admin@samtec.example', password: MOCK_PASSWORD },
    });
    if (login.data?.status !== 'TWO_FACTOR_REQUIRED') {
      throw new Error('Expected a two-factor challenge');
    }

    const verified = await fetchClient.POST('/auth/2fa/verify', {
      body: { challengeToken: login.data.challengeToken, code: MOCK_TWO_FACTOR_CODE },
    });
    const me = await fetchClient.GET('/auth/me', {
      headers: { Authorization: `Bearer ${verified.data?.accessToken}` },
    });

    expect(me.data?.role).toBe('ADMIN');
  });

  it('makes an HR user set up two-factor authentication before signing in', async () => {
    const login = await fetchClient.POST('/auth/login', {
      body: { email: 'hr@samtec.example', password: MOCK_PASSWORD },
    });
    if (login.data?.status !== 'TWO_FACTOR_SETUP_REQUIRED') {
      throw new Error('Expected a request to set up two-factor authentication');
    }
    const { setupToken } = login.data;

    const setup = await fetchClient.POST('/auth/2fa/setup', { body: { setupToken } });
    expect(setup.data?.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    const enabled = await fetchClient.POST('/auth/2fa/enable', {
      body: { setupToken, code: MOCK_TWO_FACTOR_CODE },
    });
    expect(enabled.data?.user.twoFactorEnabled).toBe(true);
  });

  it('refreshes only while signed in', async () => {
    const before = await fetchClient.POST('/auth/refresh');
    expect(before.response.status).toBe(401);

    await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });
    const after = await fetchClient.POST('/auth/refresh');
    expect(after.data?.expiresInSeconds).toBe(900);

    await fetchClient.POST('/auth/logout');
    const loggedOut = await fetchClient.POST('/auth/refresh');
    expect(loggedOut.response.status).toBe(401);
  });
});
