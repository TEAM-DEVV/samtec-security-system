/**
 * The figures a manager reads at a glance, and the files they take away.
 *
 * Design: docs/plan/07-roadmap.md, Phase 6.
 *
 * **This module owns no tables.** Every figure is counted from the tables the
 * screens already read, through the modules that own them, so a report can
 * never disagree with the page beside it. That is the whole point of it being a
 * reporting module rather than a reporting database.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReportsOverview } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toIsoDate } from '../../common/dates.js';
import { PrismaService } from '../../database/prisma.service.js';
import { csvCell } from '../payroll/bank-export.js';
import type { AttendanceReportQuery } from './reports.schemas.js';

/** The window the absence figure is measured over. */
const ABSENCE_DAYS = 30;
/** How many months of payroll cost the dashboard shows. */
const COST_MONTHS = 12;
/** A run in either of these states is money the company has committed. */
const APPROVED = ['LOCKED', 'PAID'] as const;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The three figures the dashboard shows. */
  async overview(viewer: SignedInUser, now: Date = new Date()): Promise<ReportsOverview> {
    const [present, absence, payrollCost] = await Promise.all([
      this.presentNow(viewer.companyId, now),
      this.absenceRate(viewer.companyId, now),
      this.payrollCost(viewer.companyId),
    ]);
    return { present, absence, payrollCost, generatedAt: now.toISOString() };
  }

  /**
   * Who is at work at this moment.
   *
   * A shift that has begun and not ended, on a date the attendance module has
   * confirmed. A disputed shift does not count: somebody is arguing about
   * whether it happened, so it cannot be evidence that a person is standing at
   * a gate right now.
   */
  private async presentNow(companyId: string, now: Date) {
    const [onShift, activeEmployees] = await Promise.all([
      this.prisma.workSegment.count({
        where: {
          companyId,
          status: 'CONFIRMED',
          startedAt: { lte: now },
          endedAt: { gte: now },
        },
      }),
      this.prisma.employee.count({ where: { companyId, status: 'ACTIVE' } }),
    ]);
    return { onShift, activeEmployees, asOf: now.toISOString() };
  }

  /**
   * How much of the expected attendance was actually worked.
   *
   * Expected minutes come from each worker's shift pattern. A company with no
   * patterns assigned has nothing to compare against, so the rate is `null`
   * rather than zero — "nothing to compare" and "no absence at all" are very
   * different things to show a manager.
   */
  private async absenceRate(companyId: string, now: Date) {
    const toDate = toIsoDate(now);
    const fromDate = toIsoDate(new Date(now.getTime() - ABSENCE_DAYS * 86_400_000));

    const worked = await this.prisma.workSegment.aggregate({
      where: {
        companyId,
        status: 'CONFIRMED',
        workDate: { gte: fromIsoDate(fromDate), lte: fromIsoDate(toDate) },
      },
      _sum: { workedMinutes: true },
    });

    // What the roster expected: every posting that covers a day in the window,
    // multiplied by the length of its shift. Counted here rather than asked of
    // the workforce module because it is a sum, not a fact about one person.
    const postings = await this.prisma.siteAssignment.findMany({
      where: {
        companyId,
        shiftPatternId: { not: null },
        startsOn: { lte: fromIsoDate(toDate) },
        OR: [{ endsOn: null }, { endsOn: { gte: fromIsoDate(fromDate) } }],
      },
      select: {
        startsOn: true,
        endsOn: true,
        shiftPattern: { select: { startMinutes: true, endMinutes: true } },
      },
    });

    const windowStart = fromIsoDate(fromDate).getTime();
    const windowEnd = fromIsoDate(toDate).getTime();
    let scheduledMinutes = 0;
    for (const posting of postings) {
      if (posting.shiftPattern === null) {
        continue;
      }
      const from = Math.max(posting.startsOn.getTime(), windowStart);
      const to = Math.min(posting.endsOn?.getTime() ?? windowEnd, windowEnd);
      if (to < from) {
        continue;
      }
      const days = Math.round((to - from) / 86_400_000) + 1;
      const length =
        (posting.shiftPattern.endMinutes - posting.shiftPattern.startMinutes + 1440) % 1440;
      scheduledMinutes += days * length;
    }

    const workedMinutes = worked._sum.workedMinutes ?? 0;
    const missed = Math.max(0, scheduledMinutes - workedMinutes);
    return {
      fromDate,
      toDate,
      scheduledMinutes,
      workedMinutes,
      basisPoints: scheduledMinutes === 0 ? null : Math.round((missed * 10_000) / scheduledMinutes),
    };
  }

  /**
   * What each month's approved payroll cost, newest first.
   *
   * Only an approved run counts. A draft is a proposal, and showing one as a
   * cost would put a number on a chart that nobody has agreed to pay.
   */
  private async payrollCost(companyId: string) {
    const runs = await this.prisma.payrollRun.findMany({
      where: { companyId, status: { in: [...APPROVED] } },
      orderBy: [{ period: { startsOn: 'desc' } }],
      take: COST_MONTHS,
      select: {
        id: true,
        periodId: true,
        period: { select: { year: true, month: true } },
      },
    });
    if (runs.length === 0) {
      return [];
    }

    const sums = await this.prisma.payrollLine.groupBy({
      by: ['runId'],
      where: { companyId, runId: { in: runs.map((run) => run.id) } },
      _sum: {
        grossPesewas: true,
        netPayPesewas: true,
        ssnitEmployeePesewas: true,
        ssnitEmployerPesewas: true,
        payePesewas: true,
      },
    });
    const people = await this.prisma.payrollLine.groupBy({
      by: ['runId', 'employeeId'],
      where: { companyId, runId: { in: runs.map((run) => run.id) } },
    });
    const headcount = new Map<string, number>();
    for (const row of people) {
      headcount.set(row.runId, (headcount.get(row.runId) ?? 0) + 1);
    }
    const byRun = new Map(sums.map((row) => [row.runId, row._sum] as const));

    return runs.map((run) => {
      const sum = byRun.get(run.id);
      const employerSsnit = sum?.ssnitEmployerPesewas ?? 0;
      return {
        periodId: run.periodId,
        year: run.period.year,
        month: run.period.month,
        runId: run.id,
        employeeCount: headcount.get(run.id) ?? 0,
        grossPesewas: sum?.grossPesewas ?? 0,
        netPayPesewas: sum?.netPayPesewas ?? 0,
        employerSsnitPesewas: employerSsnit,
        // Everything the state is owed: both SSNIT shares and the income tax.
        statutoryPesewas:
          (sum?.ssnitEmployeePesewas ?? 0) + employerSsnit + (sum?.payePesewas ?? 0),
      };
    });
  }

  /**
   * Every confirmed shift over a date range, as a CSV.
   *
   * At most 92 days, so one request can never ask for a decade and hold the
   * database while it answers.
   */
  async attendanceCsv(
    viewer: SignedInUser,
    query: AttendanceReportQuery,
  ): Promise<{ csv: string; fileName: string }> {
    const from = fromIsoDate(query.from);
    const to = fromIsoDate(query.to);
    if (to < from) {
      throw new BadRequestException({
        message: [{ path: ['to'], message: 'The last day cannot be before the first.' }],
      });
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > 92) {
      throw new BadRequestException({
        message: [
          { path: ['to'], message: 'A report covers at most 92 days. Ask for a shorter range.' },
        ],
      });
    }

    const segments = await this.prisma.workSegment.findMany({
      where: {
        companyId: viewer.companyId,
        status: 'CONFIRMED',
        workDate: { gte: from, lte: to },
        ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
      },
      orderBy: [{ workDate: 'asc' }, { employeeId: 'asc' }],
      select: {
        workDate: true,
        workedMinutes: true,
        basis: true,
        employee: { select: { staffNumber: true, firstName: true, lastName: true } },
        site: { select: { name: true } },
      },
    });

    const header = [
      'work_date',
      'staff_number',
      'full_name',
      'site',
      'worked_minutes',
      'worked_hours',
      'clocked_in_by',
    ];
    const rows = segments.map((segment) =>
      [
        toIsoDate(segment.workDate),
        segment.employee.staffNumber,
        `${segment.employee.firstName} ${segment.employee.lastName}`,
        segment.site.name,
        String(segment.workedMinutes),
        (segment.workedMinutes / 60).toFixed(2),
        clockedInBy(segment.basis),
      ]
        .map(csvCell)
        .join(','),
    );

    return {
      csv: [header.map(csvCell).join(','), ...rows].join('\n'),
      fileName: `attendance-${query.from}-to-${query.to}.csv`,
    };
  }

  /** What payroll cost each month, as a CSV. */
  async payrollCostCsv(viewer: SignedInUser): Promise<{ csv: string; fileName: string }> {
    const months = await this.payrollCost(viewer.companyId);
    const header = [
      'year',
      'month',
      'people_paid',
      'gross_pesewas',
      'gross_ghs',
      'net_pay_pesewas',
      'net_pay_ghs',
      'employer_ssnit_pesewas',
      'owed_to_the_state_pesewas',
    ];
    const rows = months.map((one) =>
      [
        String(one.year),
        String(one.month).padStart(2, '0'),
        String(one.employeeCount),
        String(one.grossPesewas),
        (one.grossPesewas / 100).toFixed(2),
        String(one.netPayPesewas),
        (one.netPayPesewas / 100).toFixed(2),
        String(one.employerSsnitPesewas),
        String(one.statutoryPesewas),
      ]
        .map(csvCell)
        .join(','),
    );
    return {
      csv: [header.map(csvCell).join(','), ...rows].join('\n'),
      fileName: 'payroll-cost.csv',
    };
  }
}

/** How somebody clocked in, in words rather than an enum name. */
function clockedInBy(basis: 'BIOMETRIC' | 'PIN_FALLBACK' | 'MANUAL'): string {
  return basis === 'BIOMETRIC'
    ? 'Face or fingerprint'
    : basis === 'PIN_FALLBACK'
      ? 'Staff number (fallback)'
      : 'Added by hand';
}
