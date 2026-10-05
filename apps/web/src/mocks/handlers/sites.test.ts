import { beforeEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { clearSession } from '@/lib/session';
import { signInForTests } from '@/test/session';
import { mockSites } from '../data/sites';

const ACC_01 = mockSites.find((site) => site.code === 'ACC-01')?.id ?? '';
const KSI_01 = mockSites.find((site) => site.code === 'KSI-01')?.id ?? '';

/** The mock Sites API follows the same rules as the real one. */
describe('mock sites API', () => {
  // test/setup.ts resets the store and the session after every test.
  beforeEach(() => signInForTests('admin@samtec.example'));

  it('adds a site, starting ACTIVE with no guards yet, and it shows up in the list', async () => {
    const created = await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-02',
        name: 'Second Kumasi Branch',
        clientName: 'Asante Retail Holdings',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });

    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('Location')).toBe(`/api/v1/sites/${created.data?.id}`);
    expect(created.data).toMatchObject({
      code: 'KUM-02',
      status: 'ACTIVE',
      activeGuardCount: 0,
    });

    const list = await fetchClient.GET('/sites', { params: { query: { limit: 100 } } });
    expect(list.data?.items.some((site) => site.code === 'KUM-02')).toBe(true);
  });

  it('can be created INACTIVE straight away', async () => {
    const created = await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-03',
        name: 'Closed Branch',
        clientName: 'Asante Retail Holdings',
        region: 'ASHANTI',
        city: 'Kumasi',
        status: 'INACTIVE',
      },
    });
    expect(created.data?.status).toBe('INACTIVE');
  });

  it('rejects a badly shaped code', async () => {
    const refused = await fetchClient.POST('/sites', {
      body: {
        code: 'kumasi-2',
        name: 'Second Kumasi Branch',
        clientName: 'Asante Retail Holdings',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.error?.errors?.[0]?.path).toBe('code');
  });

  it('refuses a second site with the same code', async () => {
    await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-04',
        name: 'First',
        clientName: 'A Client Ltd',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });
    const refused = await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-04',
        name: 'Second',
        clientName: 'Another Client Ltd',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });
    expect(refused.response.status).toBe(409);
  });

  it('refuses anyone who is not ADMIN or HR_PAYROLL', async () => {
    await signInForTests('supervisor@samtec.example');
    const asSupervisor = await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-05',
        name: 'Somewhere',
        clientName: 'Somebody Ltd',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });
    expect(asSupervisor.response.status).toBe(403);

    clearSession();
    const signedOut = await fetchClient.GET('/sites');
    expect(signedOut.response.status).toBe(401);
  });

  it('changes a site’s details, but never its code', async () => {
    const updated = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: ACC_01 } },
      body: { name: 'Ridge Towers Renamed', city: 'Tema' },
    });
    expect(updated.data).toMatchObject({
      name: 'Ridge Towers Renamed',
      city: 'Tema',
      code: 'ACC-01',
    });

    const refused = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: ACC_01 } },
      // `code` is not a field of `UpdateSiteRequest`; sent anyway to prove
      // the mock refuses it, the same as the real API would.
      body: { code: 'ZZZ-99' },
    });
    expect(refused.response.status).toBe(400);
  });

  it('answers 404 for a site that does not exist', async () => {
    const refused = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: '01927c3e-0000-7000-8000-000000000000' } },
      body: { name: 'Anyone' },
    });
    expect(refused.response.status).toBe(404);
  });

  it('refuses to go INACTIVE while a worker is posted there', async () => {
    // KSI-01 has a device but is otherwise untouched by the other tests here;
    // switch its device off first so only the worker condition is in play.
    const devices = await fetchClient.GET('/devices', { params: { query: { siteId: KSI_01 } } });
    for (const device of devices.data?.items ?? []) {
      await fetchClient.PATCH('/devices/{deviceId}', {
        params: { path: { deviceId: device.id } },
        body: { status: 'INACTIVE' },
      });
    }

    const refused = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: KSI_01 } },
      body: { status: 'INACTIVE' },
    });

    expect(refused.response.status).toBe(409);
    expect(refused.error?.detail).toContain('Move every worker off this site');
  });

  it('refuses to go INACTIVE while one of its devices is switched on', async () => {
    // Move everybody off ACC-01 first, so only its device is in the way.
    const employees = await fetchClient.GET('/employees', {
      params: { query: { siteId: ACC_01 } },
    });
    for (const employee of employees.data?.items ?? []) {
      await fetchClient.PATCH('/employees/{employeeId}', {
        params: { path: { employeeId: employee.id } },
        body: { siteId: null },
      });
    }

    const refused = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: ACC_01 } },
      body: { status: 'INACTIVE' },
    });

    expect(refused.response.status).toBe(409);
    expect(refused.error?.detail).toContain('Switch off every device');
  });

  it('refuses to go INACTIVE when both a worker and a device are still there', async () => {
    // ACC-01 starts with both, untouched by the other tests.
    const refused = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: ACC_01 } },
      body: { status: 'INACTIVE' },
    });

    expect(refused.response.status).toBe(409);
    expect(refused.error?.detail).toContain('Move every worker off this site and switch off');
  });

  it('goes INACTIVE once nobody is posted there and no device is switched on', async () => {
    // A freshly added site starts with neither.
    const created = await fetchClient.POST('/sites', {
      body: {
        code: 'KUM-06',
        name: 'Brand New Site',
        clientName: 'A Client Ltd',
        region: 'ASHANTI',
        city: 'Kumasi',
      },
    });

    const updated = await fetchClient.PATCH('/sites/{siteId}', {
      params: { path: { siteId: created.data?.id ?? '' } },
      body: { status: 'INACTIVE' },
    });

    expect(updated.data?.status).toBe('INACTIVE');
  });
});
