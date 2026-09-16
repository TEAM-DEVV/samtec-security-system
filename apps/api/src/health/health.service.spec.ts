import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { HealthService } from './health.service.js';

/**
 * A pretend database for unit tests. Because HealthService receives its
 * dependencies through the constructor, a test can hand it this fake instead
 * of a real database connection. The cast is safe: HealthService only calls
 * `isReachable`.
 */
function fakeDatabase(reachable: boolean) {
  const isReachable = vi.fn(async () => reachable);
  return { database: { isReachable } as unknown as PrismaService, isReachable };
}

describe('HealthService', () => {
  it('reports ok when the database answers', async () => {
    const { database } = fakeDatabase(true);

    const report = await new HealthService(database).check();

    expect(report).toMatchObject({ status: 'ok', checks: { database: 'up' } });
  });

  it('reports degraded when the database is down', async () => {
    const { database } = fakeDatabase(false);

    const report = await new HealthService(database).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('down');
  });

  it('reuses a recent database check instead of querying on every call', async () => {
    const { database, isReachable } = fakeDatabase(true);
    const health = new HealthService(database);

    await health.check();
    await health.check();

    expect(isReachable).toHaveBeenCalledTimes(1);
  });

  it('shares only what a public endpoint needs', async () => {
    const { database } = fakeDatabase(true);

    const report = await new HealthService(database).check();

    expect(Object.keys(report).sort()).toEqual(['checks', 'status', 'time']);
  });
});
