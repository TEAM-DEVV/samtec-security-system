import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Site as ApiSite, SiteList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, Site } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { currentAssignmentFilter } from './employees.service.js';
import type { CreateSiteBody, ListSitesQuery, UpdateSiteBody } from './workforce.schemas.js';

/**
 * Reading and changing client sites. ADMIN and HR_PAYROLL see every site and
 * may add or change one; a SUPERVISOR sees only the sites they are posted to;
 * a GUARD sees none (a site they ask about "does not exist" — 404, not 403,
 * per the contract).
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Adds a client site. Contract: `createSite`. The code is short, printed on
   * devices and documents, and unique in the company for life — never
   * changed, not even here.
   */
  async create(viewer: SignedInUser, body: CreateSiteBody): Promise<ApiSite> {
    try {
      const site = await this.prisma.$transaction(async (tx) => {
        const created = await tx.site.create({
          data: {
            companyId: viewer.companyId,
            code: body.code,
            name: body.name,
            clientName: body.clientName,
            region: body.region,
            city: body.city,
            status: body.status,
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'site.created',
            entityType: 'site',
            entityId: created.id,
          },
          tx,
        );
        return created;
      });
      return toApiSite(site, 0);
    } catch (error) {
      if (isUniqueViolation(error, 'code')) {
        throw new ConflictException('A site with this code already exists.');
      }
      throw error;
    }
  }

  /**
   * Changes a site's details. Contract: `updateSite`. Only the sent fields
   * change; the code can never be changed here. Switching `status` to
   * `INACTIVE` is refused while anybody is still posted here or any device
   * here is switched on, so the site cannot quietly go dark under them.
   */
  async update(viewer: SignedInUser, siteId: string, body: UpdateSiteBody): Promise<ApiSite> {
    const current = await this.prisma.site.findFirst({
      where: { id: siteId, companyId: viewer.companyId },
    });
    if (!current) {
      throw new NotFoundException('No site exists with this ID.');
    }
    if (body.status === 'INACTIVE' && current.status !== 'INACTIVE') {
      await this.assertSafeToDeactivate(siteId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.site.update({ where: { id: siteId }, data: body });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          // Only WHICH fields changed — never their values.
          action: 'site.updated',
          entityType: 'site',
          entityId: siteId,
          detail: { changedFields: Object.keys(body).join(',') },
        },
        tx,
      );
    });
    return this.get(viewer, siteId);
  }

  /**
   * A site may go `INACTIVE` only once nobody is posted there and every
   * device there is switched off, so nothing is left quietly stranded.
   */
  private async assertSafeToDeactivate(siteId: string): Promise<void> {
    const [postedWorker, activeDevice] = await Promise.all([
      this.prisma.siteAssignment.findFirst({
        where: { siteId, ...currentAssignmentFilter() },
        select: { id: true },
      }),
      this.prisma.device.findFirst({
        where: { siteId, status: 'ACTIVE' },
        select: { id: true },
      }),
    ]);
    if (postedWorker && activeDevice) {
      throw new ConflictException(
        'Move every worker off this site and switch off its devices before making it inactive.',
      );
    }
    if (postedWorker) {
      throw new ConflictException('Move every worker off this site before making it inactive.');
    }
    if (activeDevice) {
      throw new ConflictException(
        'Switch off every device at this site before making it inactive.',
      );
    }
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
   * Other modules use this to scope their own records the same way. Pass
   * the transaction client (`db`) to read inside a transaction.
   */
  async visibleSiteIds(
    viewer: SignedInUser,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string[] | undefined> {
    if (viewer.role === 'ADMIN' || viewer.role === 'HR_PAYROLL') {
      return undefined;
    }
    return viewer.role === 'SUPERVISOR' ? this.supervisorSiteIds(viewer, db) : [];
  }

  private async supervisorSiteIds(
    viewer: SignedInUser,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    if (!viewer.employeeId) {
      return [];
    }
    const assignments = await db.siteAssignment.findMany({
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
