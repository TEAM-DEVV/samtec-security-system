import { beforeEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { clearSession } from '@/lib/session';
import { signInForTests } from '@/test/session';
import { mockPosts, mockShiftPatterns } from '../data/rosters';
import { mockSites } from '../data/sites';

const ACC_01 = mockSites.find((site) => site.code === 'ACC-01')?.id ?? '';
const TEM_01 = mockSites.find((site) => site.code === 'TEM-01')?.id ?? '';
const MAIN_GATE =
  mockPosts.find((post) => post.siteId === ACC_01 && post.name === 'Main Gate')?.id ?? '';
const DAY_SHIFT = mockShiftPatterns.find((pattern) => pattern.name === 'Day Shift')?.id ?? '';

/** The mock Rosters API follows the same rules as the real one. */
describe('mock rosters API', () => {
  // test/setup.ts resets the store and the session after every test.
  beforeEach(() => signInForTests('admin@samtec.example'));

  it('lists the posts at a site', async () => {
    const list = await fetchClient.GET('/sites/{siteId}/posts', {
      params: { path: { siteId: ACC_01 }, query: { limit: 100 } },
    });
    expect(list.response.status).toBe(200);
    expect(list.data?.items.some((post) => post.name === 'Main Gate')).toBe(true);
  });

  it('adds a post to a site', async () => {
    const created = await fetchClient.POST('/sites/{siteId}/posts', {
      params: { path: { siteId: ACC_01 } },
      body: { name: 'Car Park', requiredGuards: 1 },
    });
    expect(created.response.status).toBe(201);
    expect(created.data).toMatchObject({ name: 'Car Park', status: 'ACTIVE' });
  });

  it('changes a post', async () => {
    const updated = await fetchClient.PATCH('/posts/{postId}', {
      params: { path: { postId: MAIN_GATE } },
      body: { requiredGuards: 3 },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data?.requiredGuards).toBe(3);
  });

  it('lists the shift patterns', async () => {
    const list = await fetchClient.GET('/shift-patterns', { params: { query: { limit: 100 } } });
    expect(list.response.status).toBe(200);
    expect(list.data?.items.some((pattern) => pattern.name === 'Day Shift')).toBe(true);
  });

  it('adds a shift pattern', async () => {
    const created = await fetchClient.POST('/shift-patterns', {
      body: { name: 'Weekend Shift', startTime: '08:00', endTime: '20:00' },
    });
    expect(created.response.status).toBe(201);
    expect(created.data?.crossesMidnight).toBe(false);
  });

  it('changes a shift pattern', async () => {
    const updated = await fetchClient.PATCH('/shift-patterns/{shiftPatternId}', {
      params: { path: { shiftPatternId: DAY_SHIFT } },
      body: { endTime: '19:00' },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data?.endTime).toBe('19:00');
  });

  it('lets a supervisor read the roster, but never change it', async () => {
    await signInForTests('supervisor@samtec.example');

    const posts = await fetchClient.GET('/sites/{siteId}/posts', {
      params: { path: { siteId: ACC_01 } },
    });
    expect(posts.response.status).toBe(200);

    const patterns = await fetchClient.GET('/shift-patterns');
    expect(patterns.response.status).toBe(200);

    const refusedPost = await fetchClient.POST('/sites/{siteId}/posts', {
      params: { path: { siteId: ACC_01 } },
      body: { name: 'Car Park', requiredGuards: 1 },
    });
    expect(refusedPost.response.status).toBe(403);

    const refusedPattern = await fetchClient.PATCH('/shift-patterns/{shiftPatternId}', {
      params: { path: { shiftPatternId: DAY_SHIFT } },
      body: { endTime: '19:00' },
    });
    expect(refusedPattern.response.status).toBe(403);
  });

  it('hides another site from a supervisor: its posts "do not exist"', async () => {
    await signInForTests('supervisor@samtec.example');

    // Yaw Boateng is posted to ACC-01. Reading TEM-01's posts is a 404, not a
    // 403, so nothing is learned about that site, not even that it has posts:
    // the same answer the real `SitesService.get` gives.
    const hidden = await fetchClient.GET('/sites/{siteId}/posts', {
      params: { path: { siteId: TEM_01 } },
    });
    expect(hidden.response.status).toBe(404);

    // Adding a post there is refused by role first (403): the real API's
    // RolesGuard answers before the service ever looks at the site.
    const refused = await fetchClient.POST('/sites/{siteId}/posts', {
      params: { path: { siteId: TEM_01 } },
      body: { name: 'Loading Bay', requiredGuards: 2 },
    });
    expect(refused.response.status).toBe(403);
  });

  it('lets HR read and add posts at any site, like an administrator', async () => {
    await signInForTests('hr@samtec.example');

    // HR is posted nowhere, and for them that means every site, not none.
    const posts = await fetchClient.GET('/sites/{siteId}/posts', {
      params: { path: { siteId: TEM_01 } },
    });
    expect(posts.response.status).toBe(200);

    const created = await fetchClient.POST('/sites/{siteId}/posts', {
      params: { path: { siteId: TEM_01 } },
      body: { name: 'Loading Bay', requiredGuards: 2 },
    });
    expect(created.response.status).toBe(201);
    expect(created.data?.siteId).toBe(TEM_01);
  });

  it('refuses a guard the roster entirely, and refuses anybody signed out', async () => {
    await signInForTests('guard@samtec.example');
    const asGuard = await fetchClient.GET('/sites/{siteId}/posts', {
      params: { path: { siteId: ACC_01 } },
    });
    expect(asGuard.response.status).toBe(403);

    clearSession();
    const signedOut = await fetchClient.GET('/shift-patterns');
    expect(signedOut.response.status).toBe(401);
  });
});
