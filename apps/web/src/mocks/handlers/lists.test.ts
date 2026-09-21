import { beforeEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { clearSession } from '@/lib/session';
import { signInForTests } from '@/test/session';

/** The mock list endpoints check their inputs the way the contract says the real API will. */
describe('mock employees and sites API', () => {
  beforeEach(() => signInForTests());

  it('needs a signed-in user', async () => {
    clearSession();

    const { response, error } = await fetchClient.GET('/sites');

    expect(response.status).toBe(401);
    expect(error?.detail).toBe('Sign in to continue.');
  });

  it('refuses a page size above 100', async () => {
    const { error, response } = await fetchClient.GET('/employees', {
      params: { query: { limit: 101 } },
    });

    expect(response.status).toBe(400);
    expect(error?.errors?.[0]?.path).toBe('limit');
  });

  it('refuses a search longer than 100 characters', async () => {
    const { response } = await fetchClient.GET('/employees', {
      params: { query: { search: 'x'.repeat(101) } },
    });

    expect(response.status).toBe(400);
  });

  it('answers 400 for an ID that is not a UUID, and 404 for an unknown one', async () => {
    const badId = await fetchClient.GET('/employees/{employeeId}', {
      params: { path: { employeeId: 'not-an-id' } },
    });
    const unknownId = await fetchClient.GET('/sites/{siteId}', {
      params: { path: { siteId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c99' } },
    });

    expect(badId.response.status).toBe(400);
    expect(unknownId.response.status).toBe(404);
  });

  it('sorts sites by code', async () => {
    const { data } = await fetchClient.GET('/sites');

    expect(data?.items.map((site) => site.code)).toEqual([
      'ACC-01',
      'ACC-02',
      'KSI-01',
      'TEM-01',
      'TKD-01',
    ]);
  });
});
