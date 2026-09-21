import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Site as ApiSite, SiteList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, Site } from '../../generated/prisma/client.js';
import { currentAssignmentFilter } from './employees.service.js';
import type { ListSitesQuery } from './workforce.schemas.js';

/**
 * Reading client sites. ADMIN and HR_PAYROLL see every site; a SUPERVISOR
 * sees only the sites they are posted to; a GUARD sees none (a site they ask
 * about "does not exist" — 404, not 403, per the contract).
 */
@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(viewer: SignedInUser, query: ListSitesQuery): Promise<SiteList> {
    const afterCode = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && afterCode === undefined) {
      throw new BadRequestException({
        message: [
          {
            path: ['cursor'],
            message: 'The cursor is not valid. Start again from the first page.',
          },
        ],
      });
    }

    let visibleSiteIds: string[] | undefined;
    if (viewer.role === 'SUPERVISOR') {
      visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (visibleSiteIds.length === 0) {
        return { items: [], nextCursor: null };
      }
    }

    const where: Prisma.SiteWhereInput = {
      companyId: viewer.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.region ? { region: query.region } : {}),
      ...(afterCode ? { code: { gt: afterCode } } : {}),
      ...(visibleSiteIds ? { id: { in: visibleSiteIds } } : {}),
    };

    const rows = await this.prisma.site.findMany({
      where,
      orderBy: { code: 'asc' },
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.code);
    const guardCounts = await this.activeGuardCounts(pageRows.map((row) => row.id));
    return {
      items: pageRows.map((row) => toApiSite(row, guardCounts.get(row.id) ?? 0)),
      nextCursor,
    };
  }

  async get(viewer: SignedInUser, siteId: string): Promise<ApiSite> {
    if (viewer.role === 'GUARD') {
      throw new NotFoundException('No site exists with this ID.');
    }
    if (viewer.role === 'SUPERVISOR') {
      const visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (!visibleSiteIds.includes(siteId)) {
        throw new NotFoundException('No site exists with this ID.');
      }
    }
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, companyId: viewer.companyId },
    });
    if (!row) {
      throw new NotFoundException('No site exists with this ID.');
    }
    const guardCounts = await this.activeGuardCounts([row.id]);
    return toApiSite(row, guardCounts.get(row.id) ?? 0);
  }

  /** How many ACTIVE employees are posted to each site today, in one query. */
  private async activeGuardCounts(siteIds: string[]): Promise<Map<string, number>> {
    if (siteIds.length === 0) {
      return new Map();
    }
    const groups = await this.prisma.siteAssignment.groupBy({
      by: ['siteId'],
      where: {
        siteId: { in: siteIds },
        ...currentAssignmentFilter(),
        employee: { status: 'ACTIVE' },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.siteId, group._count._all]));
  }

  /**
   * The sites a viewer may see: undefined means every site (ADMIN and
   * HR_PAYROLL), a GUARD sees none, a SUPERVISOR the sites they are posted to.
   * Other modules use this to scope their own records the same way.
   */
  async visibleSiteIds(viewer: SignedInUser): Promise<string[] | undefined> {
    if (viewer.role === 'ADMIN' || viewer.role === 'HR_PAYROLL') {
      return undefined;
    }
    return viewer.role === 'SUPERVISOR' ? this.supervisorSiteIds(viewer) : [];
  }

  private async supervisorSiteIds(viewer: SignedInUser): Promise<string[]> {
    if (!viewer.employeeId) {
      return [];
    }
    const assignments = await this.prisma.siteAssignment.findMany({
      where: { employeeId: viewer.employeeId, ...currentAssignmentFilter() },
      select: { siteId: true },
    });
    return assignments.map((assignment) => assignment.siteId);
  }
}

function toApiSite(site: Site, activeGuardCount: number): ApiSite {
  return {
    id: site.id,
    code: site.code,
    name: site.name,
    clientName: site.clientName,
    region: site.region,
    city: site.city,
    status: site.status,
    activeGuardCount,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}
