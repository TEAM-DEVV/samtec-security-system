/**
 * Payroll months: opening one, listing them, and closing one for good.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md. A period is exactly one
 * calendar month, it is opened once and closed once, and closing it is final —
 * all three are also rules the database enforces, so this service's job is to
 * turn each of them into a clear answer rather than to be the only guard.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PayrollPeriod as ApiPayrollPeriod, PayrollPeriodList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { PayrollPeriod, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import type { CreatePeriodBody, ListPeriodsQuery } from './payroll.schemas.js';
import { toApiPeriod } from './payroll-mapping.js';

/** A run in either of these states is the one approved run of its month. */
const APPROVED = ['LOCKED', 'PAID'] as const;

@Injectable()
export class PayrollPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The company's payroll months, newest first. */
  async list(viewer: SignedInUser, query: ListPeriodsQuery): Promise<PayrollPeriodList> {
    const after = this.startsOnBefore(query.cursor);
    const rows = await this.prisma.payrollPeriod.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.year === undefined ? {} : { year: query.year }),
        ...(after === undefined ? {} : { startsOn: { lt: after } }),
      },
      orderBy: { startsOn: 'desc' },
      take: query.limit + 1,
    });

    const page = toPage(rows, query.limit, (row) => toIsoDate(row.startsOn));
    const lockedRuns = await this.lockedRunIds(
      viewer.companyId,
      page.pageRows.map((row) => row.id),
    );
    return {
      items: page.pageRows.map((row) => toApiPeriod(row, lockedRuns.get(row.id) ?? null)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Opens a month. The two dates are worked out here rather than sent, so a
   * period can never be anything but a whole calendar month — which the
   * calculation depends on, because it pro-rates by the days in the period.
   */
  async create(viewer: SignedInUser, body: CreatePeriodBody): Promise<ApiPayrollPeriod> {
    const startsOn = fromIsoDate(`${body.year}-${String(body.month).padStart(2, '0')}-01`);
    const endsOn = new Date(Date.UTC(body.year, body.month, 0));

    const created = await this.prisma.$transaction(async (tx) => {
      const clash = await tx.payrollPeriod.findFirst({
        where: { companyId: viewer.companyId, year: body.year, month: body.month },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('This month already has a payroll period.');
      }
      const period = await tx.payrollPeriod.create({
        data: {
          companyId: viewer.companyId,
          year: body.year,
          month: body.month,
          startsOn,
          endsOn,
          status: 'OPEN',
        },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.period_opened',
          entityType: 'payroll_period',
          entityId: period.id,
          detail: { year: period.year, month: period.month },
        },
        tx,
      );
      return period;
    });

    // A brand-new month cannot have an approved run yet.
    return toApiPeriod(created, null);
  }

  /**
   * Closes a month for good. After this no new run may be calculated for it,
   * and a draft inside it can no longer be submitted — but a run that was
   * already approved may still be marked paid, because the money may leave the
   * bank after the books are closed.
   */
  async close(viewer: SignedInUser, periodId: string): Promise<ApiPayrollPeriod> {
    const closed = await this.prisma.$transaction(async (tx) => {
      await this.byId(viewer, periodId, tx);

      // The condition rides on the update itself, so two people closing the
      // same month at the same time get a clear 409 rather than a trigger.
      const changed = await tx.payrollPeriod.updateMany({
        where: { id: periodId, companyId: viewer.companyId, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: viewer.userId },
      });
      if (changed.count !== 1) {
        throw new ConflictException('This month is already closed.');
      }

      const period = await this.byId(viewer, periodId, tx);
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.period_closed',
          entityType: 'payroll_period',
          entityId: periodId,
          detail: { year: period.year, month: period.month },
        },
        tx,
      );
      return period;
    });

    const lockedRuns = await this.lockedRunIds(viewer.companyId, [closed.id]);
    return toApiPeriod(closed, lockedRuns.get(closed.id) ?? null);
  }

  /**
   * One month of this company, or 404. A period of another company answers
   * 404 as well, so nobody can learn which IDs exist.
   */
  async byId(
    viewer: SignedInUser,
    periodId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PayrollPeriod> {
    const period = await tx.payrollPeriod.findFirst({
      where: { id: periodId, companyId: viewer.companyId },
    });
    if (!period) {
      throw new NotFoundException('No payroll period exists with this ID.');
    }
    return period;
  }

  // ---------------------------------------------------------------------------

  /** The approved run of each of these months, where there is one. */
  private async lockedRunIds(companyId: string, periodIds: string[]): Promise<Map<string, string>> {
    if (periodIds.length === 0) {
      return new Map();
    }
    const runs = await this.prisma.payrollRun.findMany({
      where: { companyId, periodId: { in: periodIds }, status: { in: [...APPROVED] } },
      select: { id: true, periodId: true },
    });
    return new Map(runs.map((run) => [run.periodId, run.id]));
  }

  /** The start date a cursor points just past, or a clear 400. */
  private startsOnBefore(cursor: string | undefined): Date | undefined {
    if (cursor === undefined) {
      return undefined;
    }
    const value = decodeCursor(cursor);
    if (value === undefined) {
      throw new BadRequestException({
        message: [
          {
            path: ['cursor'],
            message: 'The cursor is not valid. Start again from the first page.',
          },
        ],
      });
    }
    return fromIsoDate(value);
  }
}
