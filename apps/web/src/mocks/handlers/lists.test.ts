import { beforeEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { clearSession } from '@/lib/session';
import { signInForTests } from '@/test/session';

/** The mock list endpoints check their inputs the way the contract says the real API will. */
describe('mock employees and sites API', () => {
  // An administrator sees everything; the role-scoping tests below sign in as others.
  beforeEach(() => signInForTests('admin@samtec.example'));

  it('needs a signed-in user', async () => {
    clearSession();

    const { response, error } = await fetchClient.GET('/sites');

    expect(response.status).toBe(401);
    expect(error?.detail).toBe('Sign in to continue.');
  });

  it('refuses the lists to a guard with the API wording', async () => {
    await signInForTests('guard@samtec.example');

    const employees = await fetchClient.GET('/employees');
    const sites = await fetchClient.GET('/sites');

    expect(employees.response.status).toBe(403);
    expect(sites.response.status).toBe(403);
    expect(employees.error?.detail).toBe('Your role does not allow this action.');
  });

  it('shows a supervisor only the people and the site they are posted to', async () => {
    await signInForTests('supervisor@samtec.example');

    const employees = await fetchClient.GET('/employees');
    const sites = await fetchClient.GET('/sites');

    // Yaw Boateng supervises ACC-01, where Kwame Kofi Mensah also works.
    expect(employees.data?.items.map((employee) => employee.staffNumber)).toEqual([
      'SMT-00001',
      'SMT-00003',
    ]);
    expect(sites.data?.items.map((site) => site.code)).toEqual(['ACC-01']);
  });

  it('lets a guard open only their own record, with their Ghana Card number', async () => {
    await signInForTests('guard@samtec.example');
    const self = '01927c3e-5a4b-7c8d-9e0f-000000000001';
    const colleague = '01927c3e-5a4b-7c8d-9e0f-000000000002';

    const own = await fetchClient.GET('/employees/{employeeId}', {
      params: { path: { employeeId: self } },
    });
    const other = await fetchClient.GET('/employees/{employeeId}', {
      params: { path: { employeeId: colleague } },
    });

    expect(own.data?.staffNumber).toBe('SMT-00001');
    expect(own.data?.ghanaCardNumber).toBeDefined();
    // "Does not exist", never "not allowed": the answer must not reveal the record is real.
    expect(other.response.status).toBe(404);
  });

  it('withholds the Ghana Card number from a supervisor and hides other sites', async () => {
    await signInForTests('supervisor@samtec.example');
    const atOwnSite = '01927c3e-5a4b-7c8d-9e0f-000000000001'; // ACC-01
    const atOtherSite = '01927c3e-5a4b-7c8d-9e0f-000000000004'; // ACC-02

    const visible = await fetchClient.GET('/employees/{employeeId}', {
      params: { path: { employeeId: atOwnSite } },
    });
    const hidden = await fetchClient.GET('/employees/{employeeId}', {
      params: { path: { employeeId: atOtherSite } },
    });

    expect(visible.data?.fullName).toBe('Kwame Kofi Mensah');
    expect(visible.data?.ghanaCardNumber).toBeUndefined();
    expect(hidden.response.status).toBe(404);
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
      'CPC-01',
      'KSI-01',
      'TEM-01',
      'TKD-01',
    ]);
  });
});
