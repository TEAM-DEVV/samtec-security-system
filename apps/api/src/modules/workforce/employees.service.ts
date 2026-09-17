import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Employee as ApiEmployee, EmployeeList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { toEmployeeDetail, toEmployeeListItem } from './employee-mapping.js';
import type { ListEmployeesQuery } from './workforce.schemas.js';

/** An assignment that covers today: it has started and has not ended. */
export function currentAssignmentFilter(today: Date = new Date()) {
  return {
    startsOn: { lte: today },
    OR: [{ endsOn: null }, { endsOn: { gte: today } }],
  } satisfies Prisma.SiteAssignmentWhereInput;
}

/**
 * Reading employees, with the contract's access rules built in:
 *
 * - ADMIN and HR_PAYROLL see every employee of the company.
 * - A SUPERVISOR sees only employees posted to the sites they are posted to.
 * - A GUARD may read only their own record; lists are not for them.
 * - Records a caller may not see answer 404, never 403, so nobody can
 *   discover which IDs exist.
 */
@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(viewer: SignedInUser, query: ListEmployeesQuery): Promise<EmployeeList> {
    if (viewer.role === 'GUARD') {
      throw new ForbiddenException('Your role does not allow this action.');
    }

    const afterStaffNumber = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && afterStaffNumber === undefined) {
      throw new BadRequestException({
        message: [
          {
            path: ['cursor'],
            message: 'The cursor is not valid. Start again from the first page.',
          },
        ],
      });
    }

    // A supervisor's world is the sites they are currently posted to.
    let visibleSiteIds: string[] | undefined;
    if (viewer.role === 'SUPERVISOR') {
      visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (visibleSiteIds.length === 0) {
        return { items: [], nextCursor: null };
      }
    }

    const postedTo = (siteIds: string[] | { equals: string }) => ({
      assignments: {
        some: {
          ...currentAssignmentFilter(),
          siteId: Array.isArray(siteIds) ? { in: siteIds } : siteIds.equals,
        },
      },
    });

    const where: Prisma.EmployeeWhereInput = {
      companyId: viewer.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(afterStaffNumber ? { staffNumber: { gt: afterStaffNumber } } : {}),
      AND: [
        ...(query.siteId ? [postedTo({ equals: query.siteId })] : []),
        ...(visibleSiteIds ? [postedTo(visibleSiteIds)] : []),
        ...(query.search
          ? [
              {
                OR: [
                  { staffNumber: { contains: query.search, mode: 'insensitive' as const } },
                  { firstName: { contains: query.search, mode: 'insensitive' as const } },
                  { lastName: { contains: query.search, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    // One extra row tells us whether a next page exists (see common/pagination.ts).
    const rows = await this.prisma.employee.findMany({
      where,
      orderBy: { staffNumber: 'asc' },
      take: query.limit + 1,
      include: this.includeCurrentSite(),
    });

    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.staffNumber);
    return {
      items: pageRows.map((row) =>
        toEmployeeListItem({ employee: row, currentSite: row.assignments[0]?.site ?? null }),
      ),
      nextCursor,
    };
  }

  async get(viewer: SignedInUser, employeeId: string): Promise<ApiEmployee> {
    // A guard may only ask about themselves. Anything else "does not exist".
    if (viewer.role === 'GUARD' && viewer.employeeId !== employeeId) {
      throw new NotFoundException('No employee exists with this ID.');
    }

    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId: viewer.companyId },
      include: this.includeCurrentSite(),
    });
    if (!row) {
      throw new NotFoundException('No employee exists with this ID.');
    }

    const currentSite = row.assignments[0]?.site ?? null;
    if (viewer.role === 'SUPERVISOR' && viewer.employeeId !== employeeId) {
      const visibleSiteIds = await this.supervisorSiteIds(viewer);
      if (!currentSite || !visibleSiteIds.includes(currentSite.id)) {
        throw new NotFoundException('No employee exists with this ID.');
      }
    }

    const includeGhanaCardNumber =
      viewer.role === 'ADMIN' || viewer.role === 'HR_PAYROLL' || viewer.employeeId === employeeId;
    return toEmployeeDetail({ employee: row, currentSite }, includeGhanaCardNumber);
  }

  /** The sites this supervisor is currently posted to (usually one). */
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

  private includeCurrentSite() {
    return {
      assignments: {
        where: currentAssignmentFilter(),
        include: { site: true },
        take: 1,
      },
    } satisfies Prisma.EmployeeInclude;
  }
}
