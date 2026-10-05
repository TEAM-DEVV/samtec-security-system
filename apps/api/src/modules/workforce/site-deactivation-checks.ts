import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * One reason a site cannot go `INACTIVE` yet, asked of another module. It
 * answers a short clause for the refusal ("switch off every device at this
 * site") or `null` when nothing that module owns stands in the way. It runs
 * inside the transaction that changes the site, so it must read through `db`.
 */
export type SiteDeactivationCheck = (
  companyId: string,
  siteId: string,
  db: Prisma.TransactionClient,
) => Promise<string | null>;

/**
 * The checks other modules add before a site may go `INACTIVE`.
 *
 * The workforce module owns sites, but whether a site can safely go dark also
 * depends on tables other modules own — today, the attendance module's
 * devices. Imports point one way only (attendance → workforce → identity), so
 * the workforce module cannot ask the attendance module. Instead it keeps this
 * list: a module with a reason a site must stay active registers its check
 * here when it starts (`DevicesService` does, in `onModuleInit`), and
 * `SitesService.update` runs every check before it lets a site go inactive.
 * The workforce module never reads another module's table for this.
 */
@Injectable()
export class SiteDeactivationChecks {
  private readonly checks: SiteDeactivationCheck[] = [];

  /** Adds a check. Each module registers its own once, when it starts. */
  register(check: SiteDeactivationCheck): void {
    this.checks.push(check);
  }

  /**
   * Every registered reason this site must stay active, in the order the
   * checks were registered. Empty when the site may go inactive.
   */
  async reasonsToRefuse(
    companyId: string,
    siteId: string,
    db: Prisma.TransactionClient,
  ): Promise<string[]> {
    const reasons: string[] = [];
    for (const check of this.checks) {
      const reason = await check(companyId, siteId, db);
      if (reason !== null) {
        reasons.push(reason);
      }
    }
    return reasons;
  }
}
