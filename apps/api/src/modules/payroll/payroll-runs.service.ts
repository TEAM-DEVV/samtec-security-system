/**
 * Calculating a month's pay, and reading it back.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md. This is the orchestration and
 * nothing else — every figure is worked out by the pure functions in
 * `pay-calculation.ts` and `worked-minutes.ts`, which is what lets the eight
 * hand-calculated payslips be tests rather than hopes.
 *
 * Two habits carry the weight:
 *
 * - **A run copies every input into its lines.** The salary, the rate, the days,
 *   the minutes, the tax table version: all of it, so a locked run can be
 *   re-checked years later without reading a single other table, even after
 *   somebody's pay has changed three times (decision 16).
 * - **Calculating again makes another draft.** Nothing is ever recalculated in
 *   place, because a figure that changes underneath a person who is reading it
 *   is how an approval ends up covering numbers nobody saw.
 *
 * It asks other modules for what it does not own: the workforce module for
 * people, their employment spells and what they were scheduled, and the
 * attendance module for confirmed shifts.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  PayrollRun as ApiPayrollRun,
  PayrollLineList,
  PayrollRunExclusion,
  PayrollRunList,
  PayrollStatutorySummary,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AttendanceFactsService } from '../attendance/attendance-facts.service.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import { calculatePay, type TaxRates } from './pay-calculation.js';
import type { CreateRunBody, ListLinesQuery, ListRunsQuery } from './payroll.schemas.js';
import { badCursor, looksLikeAnId } from './payroll-cursor.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import {
  emptyRunSummary,
  type LineWithEmployee,
  type RunSummaryTotals,
  toApiLine,
  toApiRun,
  toApiRunFromSummary,
  toStatutorySummary,
} from './run-mapping.js';
import {
  DEFAULT_SCHEDULED_MINUTES,
  daysEmployedIn,
  daysInPeriod,
  minutesForPeriod,
  workedDaysIn,
} from './worked-minutes.js';

/** A line always knows which run an adjustment points back at. */
const LINE_INCLUDE = { adjustsLine: { select: { runId: true } } } as const;

@Injectable()
export class PayrollRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly periods: PayrollPeriodsService,
    private readonly employees: EmployeesService,
    private readonly attendance: AttendanceFactsService,
  ) {}

  /** The company's runs, newest first. No bank details appear here. */
  async list(viewer: SignedInUser, query: ListRunsQuery): Promise<PayrollRunList> {
    // A period filter that names nothing answers 404, as the contract says,
    // rather than an empty page that looks like "this month has no runs".
    if (query.periodId !== undefined) {
      await this.periods.byId(viewer, query.periodId);
    }
    const after = this.runCursor(query.cursor);
    const rows = await this.prisma.payrollRun.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.periodId === undefined ? {} : { periodId: query.periodId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(after === undefined
          ? {}
          : {
              OR: [
                { calculatedAt: { lt: after.calculatedAt } },
                { calculatedAt: after.calculatedAt, id: { gt: after.id } },
              ],
            }),
      },
      // The moment plus the id. Two runs calculated in the same millisecond are
      // rare but not impossible, and on a timestamp alone the second one would
      // disappear from the list for ever.
      orderBy: [{ calculatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      include: {
        period: { select: { startsOn: true, endsOn: true } },
        taxTable: { select: { taxYear: true } },
      },
    });

    const page = toPage(rows, query.limit, (row) => `${row.calculatedAt.toISOString()}|${row.id}`);

    // The totals are the sums of the lines, so the database adds them up rather
    // than this code loading every line of every run on the page to do it. A
    // list of twenty runs for fifty guards is a thousand rows nobody reads.
    const summaries = await this.summariesFor(
      viewer.companyId,
      page.pageRows.map((row) => row.id),
    );

    return {
      items: page.pageRows.map((row) =>
        toApiRunFromSummary(row, {
          period: row.period,
          taxYear: row.taxTable.taxYear,
          summary: summaries.get(row.id) ?? emptyRunSummary(),
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** One run of this company, or 404. */
  async get(viewer: SignedInUser, runId: string): Promise<ApiPayrollRun> {
    const run = await this.byId(viewer, runId);
    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId },
    });
    return toApiRun(run, { period: run.period, taxYear: run.taxTable.taxYear, lines });
  }

  /**
   * The lines of one run, by staff number, with each person's adjustment lines
   * after their ordinary one.
   */
  async listLines(
    viewer: SignedInUser,
    runId: string,
    query: ListLinesQuery,
  ): Promise<PayrollLineList> {
    await this.byId(viewer, runId);
    // A worker nobody has answers 404, like everywhere else, rather than an
    // empty page that reads as "this person was paid nothing".
    if (query.employeeId !== undefined) {
      await this.employees.statusOf(viewer.companyId, query.employeeId, this.prisma);
    }
    const after = query.cursor === undefined ? undefined : this.lineCursor(query.cursor);
    const rows = await this.prisma.payrollLine.findMany({
      where: {
        companyId: viewer.companyId,
        runId,
        ...(query.employeeId === undefined ? {} : { employeeId: query.employeeId }),
        ...(after === undefined
          ? {}
          : {
              OR: [
                { staffNumber: { gt: after.staffNumber } },
                { staffNumber: after.staffNumber, id: { gt: after.id } },
              ],
            }),
      },
      // Staff number then id: an employee's ordinary line was written before
      // any adjustment, and a uuid(7) sorts by the moment it was made, so the
      // ordinary line comes first without needing a second sort key.
      orderBy: [{ staffNumber: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      include: LINE_INCLUDE,
    });

    const page = toPage(rows, query.limit, (row) => `${row.staffNumber}|${row.id}`);
    return {
      items: page.pageRows.map((row) => toApiLine(row as LineWithEmployee)),
      nextCursor: page.nextCursor,
    };
  }

  /** What the company owes the state for one run. */
  async statutorySummary(viewer: SignedInUser, runId: string): Promise<PayrollStatutorySummary> {
    const run = await this.byId(viewer, runId);
    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId },
    });
    return toStatutorySummary(run, run.period, run.taxTable, lines, new Date());
  }

  /**
   * Calculates a fresh draft for a month.
   *
   * The caller becomes the maker, which is recorded on the run and which the
   * database uses to refuse their own approval later — so this is the moment
   * the maker–checker rule is set, not the moment it is enforced.
   */
  async create(viewer: SignedInUser, body: CreateRunBody): Promise<ApiPayrollRun> {
    const period = await this.periods.byId(viewer, body.periodId);
    if (period.status !== 'OPEN') {
      throw new ConflictException(
        'This month is closed. A run can only be calculated for a month that is still open.',
      );
    }

    // The rates that applied on the last day of the month being paid, never
    // today's rates: a run for last March is worked out at last March's rates.
    const taxTable = await this.prisma.taxTable.findFirst({
      where: { companyId: viewer.companyId, effectiveFrom: { lte: period.endsOn } },
      orderBy: { effectiveFrom: 'desc' },
      include: { bands: { orderBy: { ordinal: 'asc' } } },
    });
    if (taxTable === null) {
      throw new ConflictException(
        'No version of the statutory rates covers this month. Add one before calculating pay.',
      );
    }

    const people = await this.employees.payrollFactsFor(viewer.companyId, period);
    const payTerms = await this.termsEffectiveOn(
      viewer.companyId,
      period.endsOn,
      people.map((person) => person.id),
    );
    const segments = await this.attendance.payableSegmentsByEmployee(
      viewer.companyId,
      period,
      people.map((person) => person.id),
    );

    const rates: TaxRates = {
      ssnitEmployeeBasisPoints: taxTable.ssnitEmployeeBasisPoints,
      ssnitEmployerBasisPoints: taxTable.ssnitEmployerBasisPoints,
      ssnitTier1BasisPoints: taxTable.ssnitTier1BasisPoints,
      ssnitTier2BasisPoints: taxTable.ssnitTier2BasisPoints,
      bands: taxTable.bands.map((band) => ({
        ordinal: band.ordinal,
        widthPesewas: band.widthPesewas,
        rateBasisPoints: band.rateBasisPoints,
      })),
    };
    const startDate = toIsoDate(period.startsOn);
    const endDate = toIsoDate(period.endsOn);
    const inPeriod = { startDate, endDate };
    const totalDays = daysInPeriod(inPeriod);

    const excluded: PayrollRunExclusion[] = [];
    // The run's id is not known yet, on purpose. Every id in this system is a
    // uuid(7), which sorts by the moment it was made, and the lines list pages
    // on that property — so the database assigns it rather than this code
    // inventing a version 4 that does not sort.
    const lines: Omit<Prisma.PayrollLineCreateManyInput, 'runId'>[] = [];

    for (const person of people) {
      const ref = { id: person.id, staffNumber: person.staffNumber, fullName: person.fullName };

      // A suspended worker is not paid, and is named rather than forgotten: a
      // payroll officer must see that somebody was left out on purpose.
      if (person.status === 'SUSPENDED') {
        excluded.push({ employee: ref, reason: 'SUSPENDED' });
        continue;
      }
      const terms = payTerms.get(person.id);
      if (terms === undefined) {
        excluded.push({ employee: ref, reason: 'NO_PAY_TERMS' });
        continue;
      }

      const daysEmployed = daysEmployedIn(person.employment, inPeriod);
      // Nobody is paid for a month they were not employed in for a single day.
      // The workforce filter should never hand one over, but a line is a row
      // that can never be deleted, so this refuses to write one regardless.
      if (daysEmployed < 1) {
        continue;
      }

      const days = workedDaysIn(
        segments.get(person.id) ?? [],
        inPeriod,
        (workDate) => person.scheduledMinutesOnDate.get(workDate) ?? DEFAULT_SCHEDULED_MINUTES,
      );
      const minutes = minutesForPeriod(days);
      const pay = calculatePay(
        {
          basicMonthlyPesewas: terms.basicMonthlyPesewas,
          overtimeHourlyPesewas: terms.overtimeHourlyPesewas,
          taxableAllowancePesewas: terms.taxableAllowancePesewas,
          nonTaxableAllowancePesewas: terms.nonTaxableAllowancePesewas,
          otherDeductionPesewas: terms.otherDeductionPesewas,
        },
        { daysInPeriod: totalDays, daysEmployed, overtimeMinutes: minutes.overtimeMinutes },
        rates,
      );

      lines.push({
        companyId: viewer.companyId,
        employeeId: person.id,
        staffNumber: person.staffNumber,
        fullName: person.fullName,
        employeeStatus: person.status,
        payTermsId: terms.id,
        payTermsEffectiveFrom: terms.effectiveFrom,
        basicMonthlyPesewas: terms.basicMonthlyPesewas,
        overtimeHourlyPesewas: terms.overtimeHourlyPesewas,
        daysInPeriod: totalDays,
        daysEmployed,
        scheduledMinutes: minutes.scheduledMinutes,
        punchedMinutes: minutes.punchedMinutes,
        regularMinutes: minutes.regularMinutes,
        overtimeMinutes: minutes.overtimeMinutes,
        taxTableId: taxTable.id,
        taxYear: taxTable.taxYear,
        ...pay,
      });
    }

    const run = await this.prisma.$transaction(async (tx) => {
      // Read the month again inside the transaction. Everything above took
      // several queries, and somebody may have closed it in the meantime — in
      // which case a database trigger refuses the insert, and a trigger error
      // is not an HTTP exception, so the caller would get a 500 for what is
      // plainly a 409.
      const stillOpen = await tx.payrollPeriod.findFirst({
        where: { id: period.id, companyId: viewer.companyId, status: 'OPEN' },
        select: { id: true },
      });
      if (stillOpen === null) {
        throw new ConflictException(
          'This month was closed while the run was being worked out. Nothing was saved.',
        );
      }

      const created = await tx.payrollRun.create({
        data: {
          companyId: viewer.companyId,
          periodId: period.id,
          taxTableId: taxTable.id,
          status: 'DRAFT',
          calculatedByUserId: viewer.userId,
          excludedEmployees: excluded,
        },
        include: {
          period: { select: { startsOn: true, endsOn: true } },
          taxTable: { select: { taxYear: true } },
        },
      });
      if (lines.length > 0) {
        await tx.payrollLine.createMany({
          data: lines.map((line) => ({ ...line, runId: created.id })),
        });
      }
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.run_calculated',
          entityType: 'payroll_run',
          entityId: created.id,
          detail: {
            periodId: period.id,
            lineCount: lines.length,
            excludedCount: excluded.length,
            taxTableId: taxTable.id,
          },
        },
        tx,
      );
      return created;
    });

    const written = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId: run.id },
    });
    return toApiRun(run, {
      period: run.period,
      taxYear: run.taxTable.taxYear,
      lines: written,
    });
  }

  // ---------------------------------------------------------------------------

  /** One run of this company with what it needs to describe itself, or 404. */
  private async byId(viewer: SignedInUser, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, companyId: viewer.companyId },
      include: {
        period: { select: { startsOn: true, endsOn: true } },
        taxTable: true,
      },
    });
    if (run === null) {
      throw new NotFoundException('No payroll run exists with this ID.');
    }
    return run;
  }

  /**
   * The pay terms that applied to each worker on one day: the latest row
   * starting on or before it.
   *
   * One query for the whole company rather than one per person, because a run
   * of fifty guards should not be fifty round trips.
   */
  private async termsEffectiveOn(companyId: string, on: Date, employeeIds: string[]) {
    if (employeeIds.length === 0) {
      return new Map<string, never>();
    }
    const rows = await this.prisma.employeePayTerms.findMany({
      // Only the people this run is about. Pay terms are history and never
      // deleted, so a company running for a decade has many rows per person and
      // most of them belong to months this run is not paying.
      where: { companyId, employeeId: { in: employeeIds }, effectiveFrom: { lte: on } },
      orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      // Sorted newest first per employee, so the first one seen is the one.
      if (!latest.has(row.employeeId)) {
        latest.set(row.employeeId, row);
      }
    }
    return latest;
  }

  /**
   * The moment and id a runs cursor points just past, or a clear 400.
   *
   * Both halves are checked. A cursor that decodes to something without an id,
   * or with a moment that is not a date, is a bad request and not a 500 from
   * the query layer — which is what happens if either half reaches Prisma.
   */
  private runCursor(cursor: string | undefined): { calculatedAt: Date; id: string } | undefined {
    if (cursor === undefined) {
      return undefined;
    }
    const value = decodeCursor(cursor);
    const [moment, id] = (value ?? '').split('|');
    if (moment === undefined || !looksLikeAnId(id)) {
      throw badCursor();
    }
    const calculatedAt = new Date(moment);
    if (Number.isNaN(calculatedAt.getTime())) {
      throw badCursor();
    }
    return { calculatedAt, id };
  }

  /** The staff number and id a lines cursor points just past, or a clear 400. */
  private lineCursor(cursor: string): { staffNumber: string; id: string } {
    const value = decodeCursor(cursor);
    const [staffNumber, id] = (value ?? '').split('|');
    if (staffNumber === undefined || staffNumber.length === 0 || !looksLikeAnId(id)) {
      throw badCursor();
    }
    return { staffNumber, id };
  }

  /**
   * The totals and counts of several runs at once, added up by the database.
   *
   * Two grouped queries rather than one row per payroll line: the totals are
   * sums, and `employeeCount` is a count of distinct people, which a sum cannot
   * give — so that one is its own grouping.
   */
  private async summariesFor(companyId: string, runIds: string[]) {
    const summaries = new Map<string, RunSummaryTotals>();
    if (runIds.length === 0) {
      return summaries;
    }
    const sums = await this.prisma.payrollLine.groupBy({
      by: ['runId'],
      where: { companyId, runId: { in: runIds } },
      _count: { _all: true },
      _sum: {
        basicPesewas: true,
        overtimePesewas: true,
        taxableAllowancePesewas: true,
        nonTaxableAllowancePesewas: true,
        grossPesewas: true,
        ssnitEmployeePesewas: true,
        ssnitEmployerPesewas: true,
        payePesewas: true,
        otherDeductionsPesewas: true,
        netPayPesewas: true,
      },
    });
    const people = await this.prisma.payrollLine.groupBy({
      by: ['runId', 'employeeId'],
      where: { companyId, runId: { in: runIds } },
    });
    const adjustments = await this.prisma.payrollLine.groupBy({
      by: ['runId'],
      where: { companyId, runId: { in: runIds }, adjustsLineId: { not: null } },
      _count: { _all: true },
    });

    const peopleByRun = new Map<string, number>();
    for (const row of people) {
      peopleByRun.set(row.runId, (peopleByRun.get(row.runId) ?? 0) + 1);
    }
    const adjustmentsByRun = new Map(
      adjustments.map((row) => [row.runId, row._count._all] as const),
    );

    for (const row of sums) {
      summaries.set(row.runId, {
        lineCount: row._count._all,
        employeeCount: peopleByRun.get(row.runId) ?? 0,
        adjustmentLineCount: adjustmentsByRun.get(row.runId) ?? 0,
        totals: {
          totalBasicPesewas: row._sum.basicPesewas ?? 0,
          totalOvertimePesewas: row._sum.overtimePesewas ?? 0,
          totalTaxableAllowancePesewas: row._sum.taxableAllowancePesewas ?? 0,
          totalNonTaxableAllowancePesewas: row._sum.nonTaxableAllowancePesewas ?? 0,
          totalGrossPesewas: row._sum.grossPesewas ?? 0,
          totalSsnitEmployeePesewas: row._sum.ssnitEmployeePesewas ?? 0,
          totalPayePesewas: row._sum.payePesewas ?? 0,
          totalOtherDeductionsPesewas: row._sum.otherDeductionsPesewas ?? 0,
          totalNetPayPesewas: row._sum.netPayPesewas ?? 0,
          totalSsnitEmployerPesewas: row._sum.ssnitEmployerPesewas ?? 0,
        },
      });
    }
    return summaries;
  }
}
