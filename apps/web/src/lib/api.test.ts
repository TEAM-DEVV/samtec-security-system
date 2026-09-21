import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { fetchClient } from '@/lib/api';
import { env } from '@/lib/env';
import { getSession, startSession } from '@/lib/session';
import { server } from '@/mocks/node';
import { signInForTests } from '@/test/session';

/** Counts requests to one API path while `run` executes. */
async function countRequests(path: string, run: () => Promise<void>): Promise<number> {
  let count = 0;
  const listener = ({ request }: { request: Request }) => {
    if (new URL(request.url).pathname.endsWith(path)) {
      count += 1;
    }
  };
  server.events.on('request:start', listener);
  try {
    await run();
  } finally {
    server.events.removeListener('request:start', listener);
  }
  return count;
}

describe('fetchClient session handling', () => {
  it('sends the access token with every request', async () => {
    await signInForTests();

    const me = await fetchClient.GET('/auth/me');

    expect(me.data?.email).toBe('supervisor@samtec.example');
  });

  it('answers 401 without a session, like the real API', async () => {
    const employees = await fetchClient.GET('/employees');

    expect(employees.response.status).toBe(401);
  });

  it('gets a new token and retries when the old one has expired', async () => {
    await signInForTests();
    const user = getSession()?.user;
    if (!user) {
      throw new Error('Expected a session');
    }
    // Pretend the token expired: the mock API no longer recognises it.
    startSession({ accessToken: 'expired-token', user });

    const me = await fetchClient.GET('/auth/me');

    expect(me.response.status).toBe(200);
    expect(me.data?.email).toBe('supervisor@samtec.example');
    expect(getSession()?.accessToken).not.toBe('expired-token');
  });

  it('shares one refresh between requests that fail at the same time', async () => {
    await signInForTests();
    const user = getSession()?.user;
    if (!user) {
      throw new Error('Expected a session');
    }
    startSession({ accessToken: 'expired-token', user });

    const refreshes = await countRequests('/auth/refresh', async () => {
      const [me, employees] = await Promise.all([
        fetchClient.GET('/auth/me'),
        fetchClient.GET('/employees'),
      ]);
      expect(me.response.status).toBe(200);
      expect(employees.response.status).toBe(200);
    });

    expect(refreshes).toBe(1);
  });

  it('forgets the session when the refresh is refused', async () => {
    // A session in memory, but no refresh cookie on the mock API's side.
    startSession({
      accessToken: 'expired-token',
      user: {
        id: '01927c3e-2222-7ccc-9ddd-000000000003',
        email: 'supervisor@samtec.example',
        fullName: 'Yaw Boateng',
        role: 'SUPERVISOR',
        twoFactorEnabled: false,
        employeeId: null,
      },
    });

    const me = await fetchClient.GET('/auth/me');

    expect(me.response.status).toBe(401);
    expect(getSession()).toBeNull();
  });

  it('signs out and explains when the API does not trust this page (403 on refresh)', async () => {
    await signInForTests();
    const user = getSession()?.user;
    if (!user) {
      throw new Error('Expected a session');
    }
    startSession({ accessToken: 'expired-token', user });
    server.use(
      http.post(`${env.apiBaseUrl}/auth/refresh`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'This request must come from the SAMTEC dashboard.',
            traceId: 'trace-test-403',
          },
          { status: 403 },
        ),
      ),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const me = await fetchClient.GET('/auth/me');

    expect(me.response.status).toBe(401);
    expect(getSession()).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      'The API refused to refresh the session:',
      'This request must come from the SAMTEC dashboard.',
    );
    consoleError.mockRestore();
  });

  it('never sends the token to another website', async () => {
    await signInForTests();
    let authorization: string | null = 'not captured';
    server.use(
      http.get('https://other.example/api/v1/health', ({ request }) => {
        authorization = request.headers.get('Authorization');
        return HttpResponse.json({
          status: 'ok',
          time: '2026-09-19T00:00:00Z',
          checks: { database: 'up' },
        });
      }),
    );

    await fetchClient.GET('/health', { baseUrl: 'https://other.example/api/v1' });

    expect(authorization).toBeNull();
  });

  it('never refreshes after a wrong password', async () => {
    await signInForTests();
    const before = getSession()?.accessToken;

    const refreshes = await countRequests('/auth/refresh', async () => {
      const login = await fetchClient.POST('/auth/login', {
        body: { email: 'admin@samtec.example', password: 'not-the-password' },
      });
      expect(login.response.status).toBe(401);
    });

    expect(refreshes).toBe(0);
    expect(getSession()?.accessToken).toBe(before);
  });
});
