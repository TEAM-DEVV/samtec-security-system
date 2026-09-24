import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * How many periods back a sweep reads. Two years of months: far enough to
 * cover the year before last's audit, bounded enough that a company running
 * for a decade never makes the sweep slow.
 */
const PERIODS_READ = 24;

/**
 * A run a payroll clerk is still working on says nothing yet. These are the
 * states where somebody has put their name to it: waiting on a checker,
 * locked, or paid out. A `DRAFT` is unfinished and a `REJECTED` one was
 * already thrown out.
 */
const SETTLED = ['PENDING_APPROVAL', 'LOCKED', 'PAID'] as const;

/** One payslip line, as much of it as a rule outside payroll may see. */
export interface PaidLine {
  lineId: string;
  runId: string;
  employeeId: string;
  periodId: string;
  /** The period as `YYYY-MM`, for a reader. */
  period: string;
  periodStartsOn: Date;
  periodEndsOn: Date;
  /** The hours the pay rests on: regular plus overtime. */
  paidMinutes: number;
}

/**
 * What the payroll module will tell another module about its own tables.
 *
 * Ghost detection has to know what was paid — rule R3 compares a payslip with
 * the shifts behind it, and R6 asks whether somebody who left is still being
 * paid — but a module reads only its own tables, so the questions live here
 * and detection calls them.
 *
 * **No money leaves this file.** A line has a net pay, a bank account and a
 * Ghana Card number attached to it; a rule needs none of that, so it gets
 * minutes and identifiers and nothing else. Nor does anything here write: the
 * whole service is four columns and a date range.
 */
@Injectable()
export class PayrollFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every line on a run that has left the clerk's hands (rules R3 and R6). */
  async paidLines(companyId: string): Promise<PaidLine[]> {
    const periods = await this.prisma.payrollPeriod.findMany({
      where: { companyId, runs: { some: { status: { in: [...SETTLED] } } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: PERIODS_READ,
      select: { id: true, year: true, month: true, startsOn: true, endsOn: true },
    });
    if (periods.length === 0) {
      return [];
    }
    const byPeriod = new Map(periods.map((period) => [period.id, period]));
    const lines = await this.prisma.payrollLine.findMany({
      where: {
        companyId,
        run: { status: { in: [...SETTLED] }, periodId: { in: periods.map((row) => row.id) } },
      },
      select: {
        id: true,
        runId: true,
        employeeId: true,
        regularMinutes: true,
        overtimeMinutes: true,
        run: { select: { periodId: true } },
      },
      orderBy: { id: 'asc' },
    });
    return lines.flatMap((line) => {
      const period = byPeriod.get(line.run.periodId);
      if (!period) {
        return [];
      }
      return [
        {
          lineId: line.id,
          runId: line.runId,
          employeeId: line.employeeId,
          periodId: period.id,
          period: `${period.year}-${String(period.month).padStart(2, '0')}`,
          periodStartsOn: period.startsOn,
          periodEndsOn: period.endsOn,
          paidMinutes: line.regularMinutes + line.overtimeMinutes,
        },
      ];
    });
  }
}
