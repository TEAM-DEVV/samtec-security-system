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
import { randomUUID } from 'node:crypto';
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
import { badCursor } from './payroll-cursor.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import { type LineWithEmployee, toApiLine, toApiRun, toStatutorySummary } from './run-mapping.js';
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
    const after = this.calculatedBefore(query.cursor);
    const rows = await this.prisma.payrollRun.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.periodId === undefined ? {} : { periodId: query.periodId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(after === undefined ? {} : { calculatedAt: { lt: after } }),
      },
      orderBy: { calculatedAt: 'desc' },
      take: query.limit + 1,
      include: {
        period: { select: { startsOn: true, endsOn: true } },
        taxTable: { select: { taxYear: true } },
      },
    });

    const page = toPage(rows, query.limit, (row) => row.calculatedAt.toISOString());
    // One query for the whole page's lines, not one per run.
    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId: { in: page.pageRows.map((row) => row.id) } },
    });
    const byRun = new Map<string, typeof lines>();
    for (const line of lines) {
      byRun.set(line.runId, [...(byRun.get(line.runId) ?? []), line]);
    }

    return {
      items: page.pageRows.map((row) =>
        toApiRun(row, {
          period: row.period,
          taxYear: row.taxTable.taxYear,
          lines: byRun.get(row.id) ?? [],
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
    const payTerms = await this.termsEffectiveOn(viewer.companyId, period.endsOn);
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
    const lines: Prisma.PayrollLineCreateManyInput[] = [];
    const runId = randomUUID();

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

      const days = workedDaysIn(
        segments.get(person.id) ?? [],
        inPeriod,
        (workDate) => person.scheduledMinutesOnDate.get(workDate) ?? DEFAULT_SCHEDULED_MINUTES,
      );
      const minutes = minutesForPeriod(days);
      const daysEmployed = daysEmployedIn(person.employment, inPeriod);
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
        runId,
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
      const created = await tx.payrollRun.create({
        data: {
          id: runId,
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
        await tx.payrollLine.createMany({ data: lines });
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
  private async termsEffectiveOn(companyId: string, on: Date) {
    const rows = await this.prisma.employeePayTerms.findMany({
      where: { companyId, effectiveFrom: { lte: on } },
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

  /** The moment a runs cursor points just past, or a clear 400. */
  private calculatedBefore(cursor: string | undefined): Date | undefined {
    if (cursor === undefined) {
      return undefined;
    }
    const value = decodeCursor(cursor);
    const at = value === undefined ? undefined : new Date(value);
    if (at === undefined || Number.isNaN(at.getTime())) {
      throw badCursor();
    }
    return at;
  }

  /** The staff number and id a lines cursor points just past, or a clear 400. */
  private lineCursor(cursor: string): { staffNumber: string; id: string } {
    const value = decodeCursor(cursor);
    const [staffNumber, id] = (value ?? '').split('|');
    if (staffNumber === undefined || id === undefined || id.length === 0) {
      throw badCursor();
    }
    return { staffNumber, id };
  }
}
