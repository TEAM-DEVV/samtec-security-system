import { afterEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { mockExceptions, mockSegments } from '../data/attendance';
import { mockEmployees } from '../data/employees';
import { mockSites } from '../data/sites';
import { resetMockAttendance } from './attendance';
import { resetMockDevices } from './devices';

// This file resets its own mock stores, so it needs no change to test/setup.ts.
afterEach(() => {
  resetMockAttendance();
  resetMockDevices();
});

const openExceptions = mockExceptions.filter((exception) => exception.status === 'OPEN');

const today = new Date().toISOString().slice(0, 10);
const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
const exceptionOf = (type: string) => {
  const found = mockExceptions.find((exception) => exception.type === type);
  if (!found) throw new Error(`No mock ${type} exception`);
  return found;
};

describe('mock attendance API', () => {
  it('answers 401 without signing in', async () => {
    const { response } = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today } },
    });
    expect(response.status).toBe(401);
  });

  it('shows a supervisor only their own site, and 404s another site', async () => {
    await signInForTests('supervisor@samtec.example');
    const { data } = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, limit: 100 } },
    });
    const sites = new Set(data?.items.map((segment) => segment.siteId));
    expect(data?.items.length).toBeGreaterThan(0);
    expect(sites.size).toBe(1);

    const otherSite = mockSegments.find((segment) => !sites.has(segment.siteId))?.siteId ?? '';
    const refused = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, siteId: otherSite } },
    });
    expect(refused.response.status).toBe(404);
  });

  it('shows a guard only themselves', async () => {
    await signInForTests('guard@samtec.example');
    const { data } = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, limit: 100 } },
    });
    const people = new Set(data?.items.map((segment) => segment.employee.id));
    expect(people.size).toBe(1);

    const someoneElse = mockSegments.find((segment) => !people.has(segment.employee.id));
    const refused = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, employeeId: someoneElse?.employee.id } },
    });
    expect(refused.response.status).toBe(404);
  });

  it('404s a supervisor asking about someone at another site, and a guard asking about a site', async () => {
    await signInForTests('supervisor@samtec.example');
    const { data } = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, limit: 100 } },
    });
    const mySite = data?.items[0]?.siteId;
    const elsewhere = mockEmployees.find(
      (employee) => employee.currentSite && employee.currentSite.id !== mySite,
    );
    const refused = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, employeeId: elsewhere?.id } },
    });
    expect(refused.response.status).toBe(404);

    await signInForTests('guard@samtec.example');
    const guardAsks = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: twoWeeksAgo, to: today, siteId: mySite } },
    });
    expect(guardAsks.response.status).toBe(404);
  });

  it('refuses a range longer than 31 days', async () => {
    await signInForTests('admin@samtec.example');
    const { response, error } = await fetchClient.GET('/attendance/segments', {
      params: { query: { from: '2026-01-01', to: '2026-03-01' } },
    });
    expect(response.status).toBe(400);
    expect(error?.errors?.[0]?.path).toBe('to');
  });

  it('lists the open queue for HR, but HR may not resolve', async () => {
    await signInForTests('hr@samtec.example');
    const { data } = await fetchClient.GET('/attendance/exceptions');
    expect(data?.items).toHaveLength(openExceptions.length);
    expect(data?.items.every((item) => item.allowedActions.length === 0)).toBe(true);

    const refused = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      params: { path: { exceptionId: exceptionOf('UNKNOWN_EMPLOYEE').id } },
      body: { action: 'DISMISS', note: 'Checked it.' },
    });
    expect(refused.response.status).toBe(403);
  });

  it('shows dealt-with exceptions with their resolution', async () => {
    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.GET('/attendance/exceptions', {
      params: { query: { status: 'RESOLVED' } },
    });
    expect(data?.items.length).toBeGreaterThan(0);
    expect(data?.items[0]?.resolution?.action).toBe('DISMISS');
    expect(data?.items[0]?.allowedActions).toEqual([]);
  });

  it('hides an overlap from a supervisor who runs only one of its two sites', async () => {
    const overlap = exceptionOf('OVERLAP');
    const supervisor = mockEmployees.find((employee) => employee.firstName === 'Yaw');
    const kumasi = mockSites.find((site) => site.id === overlap.siteId);
    if (!supervisor || !kumasi) throw new Error('Mock data changed');
    const posting = supervisor.currentSite;
    // For this test only, post the mock supervisor to one of the overlap's two sites.
    supervisor.currentSite = { id: kumasi.id, code: kumasi.code, name: kumasi.name };
    try {
      await signInForTests('supervisor@samtec.example');
      const { data } = await fetchClient.GET('/attendance/exceptions', {
        params: { query: { type: 'OVERLAP' } },
      });
      expect(data?.items).toEqual([]);
      const read = await fetchClient.GET('/attendance/exceptions/{exceptionId}', {
        params: { path: { exceptionId: overlap.id } },
      });
      expect(read.response.status).toBe(404);
    } finally {
      supervisor.currentSite = posting;
    }
  });

  it('lets a supervisor dismiss an unknown number at their site, with a note', async () => {
    await signInForTests('supervisor@samtec.example');
    const unknown = exceptionOf('UNKNOWN_EMPLOYEE');
    const { data } = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      params: { path: { exceptionId: unknown.id } },
      body: { action: 'DISMISS', note: 'A visitor tried the reader.' },
    });
    expect(data?.status).toBe('RESOLVED');
    expect(data?.resolution?.action).toBe('DISMISS');
  });

  it('refuses the queue to a guard', async () => {
    await signInForTests('guard@samtec.example');
    const { response } = await fetchClient.GET('/attendance/exceptions');
    expect(response.status).toBe(403);
  });

  it('adds a missing shift only around the real punch, then refuses a second resolve', async () => {
    await signInForTests('admin@samtec.example');
    const missing = exceptionOf('MISSING_CLOCK_OUT');
    const punchAt = Date.parse(missing.punch?.deviceTime ?? '');
    const path = { params: { path: { exceptionId: missing.id } } };

    const wrongWindow = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      ...path,
      body: {
        action: 'ADD_SEGMENT',
        startedAt: new Date(punchAt + 3_600_000).toISOString(),
        endedAt: new Date(punchAt + 5 * 3_600_000).toISOString(),
        note: 'Relief guard confirms.',
      },
    });
    expect(wrongWindow.response.status).toBe(400);

    const resolved = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      ...path,
      body: {
        action: 'ADD_SEGMENT',
        startedAt: new Date(punchAt).toISOString(),
        endedAt: new Date(punchAt + 12 * 3_600_000).toISOString(),
        note: 'Relief guard confirms.',
      },
    });
    expect(resolved.data?.status).toBe('RESOLVED');
    expect(resolved.data?.resolutionSegmentId).toBeTruthy();

    const again = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      ...path,
      body: { action: 'DISMISS', note: 'Twice.' },
    });
    expect(again.response.status).toBe(409);
  });

  it('keeps one side of an overlap and voids the other', async () => {
    await signInForTests('admin@samtec.example');
    const overlap = exceptionOf('OVERLAP');
    const keep = overlap.segments[0]?.id ?? '';
    const { data } = await fetchClient.POST('/attendance/exceptions/{exceptionId}/resolve', {
      params: { path: { exceptionId: overlap.id } },
      body: { action: 'KEEP_SEGMENT', segmentId: keep, note: 'Site log shows Kumasi only.' },
    });
    expect(data?.segments.map((segment) => segment.status).sort()).toEqual(['CONFIRMED', 'VOIDED']);
  });

  it('refuses an action that does not fit the type', async () => {
    await signInForTests('admin@samtec.example');
    const { response, error } = await fetchClient.POST(
      '/attendance/exceptions/{exceptionId}/resolve',
      {
        params: { path: { exceptionId: exceptionOf('UNKNOWN_EMPLOYEE').id } },
        body: {
          action: 'ADD_SEGMENT',
          startedAt: '2026-09-01T06:00:00Z',
          endedAt: '2026-09-01T18:00:00Z',
          note: 'Not allowed.',
        },
      },
    );
    expect(response.status).toBe(400);
    expect(error?.errors?.[0]?.path).toBe('action');
  });
});

describe('mock devices API', () => {
  it('is for administrators only', async () => {
    await signInForTests('supervisor@samtec.example');
    const { response } = await fetchClient.GET('/devices');
    expect(response.status).toBe(403);
  });

  it('shows a new secret once, with no-store, and a different one after rotation', async () => {
    await signInForTests('admin@samtec.example');
    const { data: list } = await fetchClient.GET('/devices');
    const registered = await fetchClient.POST('/devices', {
      body: { name: 'Test gate', siteId: list?.items[0]?.siteId ?? '', kind: 'ZKTECO' },
    });
    expect(registered.response.status).toBe(201);
    expect(registered.response.headers.get('Cache-Control')).toBe('no-store');
    const deviceId = registered.data?.device.id ?? '';

    const rotated = await fetchClient.POST('/devices/{deviceId}/rotate-secret', {
      params: { path: { deviceId } },
    });
    expect(rotated.data?.secret).toHaveLength(43);
    expect(rotated.data?.secret).not.toBe(registered.data?.secret);
    // The plain device read never carries a secret.
    const read = await fetchClient.GET('/devices/{deviceId}', { params: { path: { deviceId } } });
    expect(read.data).not.toHaveProperty('secret');
  });
});
