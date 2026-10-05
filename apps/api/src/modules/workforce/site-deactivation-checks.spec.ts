import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { SiteDeactivationChecks } from './site-deactivation-checks.js';

// The checks never touch the client in these tests; the real ones read through it.
const db = {} as Prisma.TransactionClient;

describe('the checks other modules add before a site may go inactive', () => {
  it('has no reason to refuse while nothing is registered', async () => {
    const checks = new SiteDeactivationChecks();
    await expect(checks.reasonsToRefuse('company', 'site', db)).resolves.toEqual([]);
  });

  it('collects only the checks that answer a reason, in the order they were registered', async () => {
    const checks = new SiteDeactivationChecks();
    checks.register(async () => 'switch off every device at this site');
    checks.register(async () => null);
    checks.register(async () => 'close every open post here');

    await expect(checks.reasonsToRefuse('company', 'site', db)).resolves.toEqual([
      'switch off every device at this site',
      'close every open post here',
    ]);
  });

  it('hands every check the company, the site and the transaction client it was given', async () => {
    const checks = new SiteDeactivationChecks();
    const seen: unknown[] = [];
    checks.register(async (companyId, siteId, client) => {
      seen.push(companyId, siteId, client);
      return null;
    });

    await checks.reasonsToRefuse('company-1', 'site-1', db);
    expect(seen).toEqual(['company-1', 'site-1', db]);
  });
});
