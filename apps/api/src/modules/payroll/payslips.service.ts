/**
 * Payslips: made when a run is approved, and never made again.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md. Two habits shape this file:
 *
 * - **A guard reads their own payslip and nobody else's.** Asking for somebody
 *   else's answers 404, never 403, so nobody can learn which payslips exist by
 *   probing. Their list is scoped to themselves when they name nobody; naming
 *   another employee is the same probe by another route, so it answers 404
 *   too.
 * - **The stored file is returned byte for byte.** It is never rebuilt, because
 *   a payslip somebody has already been shown must not change afterwards, and
 *   the stored fingerprint is what proves it has not.
 *
 * Almost every field of a payslip is read from the frozen payroll line rather
 * than copied again, which is why so little is stored: the line cannot change
 * once its run is submitted, so there is nothing to keep in step.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Payslip as ApiPayslip, PayslipList } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ListPayslipsQuery } from './payroll.schemas.js';
import { badCursor, looksLikeAnId } from './payroll-cursor.js';
import { payslipFileName } from './payslip-pdf.js';

/** Everything a payslip needs to describe itself, and nothing more. */
const PAYSLIP_INCLUDE = {
  line: true,
  run: {
    select: {
      status: true,
      paidAt: true,
      periodId: true,
      period: { select: { startsOn: true, endsOn: true } },
      taxTable: { select: { ssnitEmployeeBasisPoints: true, ssnitEmployerBasisPoints: true } },
    },
  },
} as const;

@Injectable()
export class PayslipsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The payslips this caller may see, newest month first.
   *
   * A guard's list is scoped to themselves before any filter is applied, so
   * asking for a colleague's does not refuse them — it simply answers with
   * their own, or with nothing. A guard account with no employee record sees an
   * empty page rather than an error, because that is a setup problem for an
   * administrator and not something to tell a worker about.
   */
  async list(viewer: SignedInUser, query: ListPayslipsQuery): Promise<PayslipList> {
    const onlyTheirs = viewer.role === 'GUARD';
    if (onlyTheirs && viewer.employeeId === null) {
      return { items: [], nextCursor: null };
    }
    // A guard who names nobody gets their own list. Naming somebody else is a
    // probe for which payslips exist, so it answers 404 like every other one.
    const employeeId = onlyTheirs ? viewer.employeeId : query.employeeId;
    if (onlyTheirs && query.employeeId !== undefined && query.employeeId !== viewer.employeeId) {
      throw new NotFoundException('No payslip exists with this ID.');
    }

    // A filter naming something that does not exist is a 404, not an empty
    // page. Both sibling lists (runs and lines), the contract and the dashboard
    // mock all answer 404 here, and the difference matters to whoever is
    // reading: an empty page says "this month has no payslips", while a 404
    // says "that is not a month". A payroll officer chasing a missing payslip
    // needs to know which.
    await this.refuseFiltersThatNameNothing(viewer, query, employeeId ?? undefined);

    const after = query.cursor === undefined ? undefined : this.payslipCursor(query.cursor);
    const rows = await this.prisma.payslip.findMany({
      where: {
        companyId: viewer.companyId,
        ...(employeeId === undefined || employeeId === null ? {} : { employeeId }),
        ...(query.runId === undefined ? {} : { runId: query.runId }),
        ...(query.periodId === undefined ? {} : { run: { periodId: query.periodId } }),
        ...(after === undefined
          ? {}
          : {
              OR: [
                { generatedAt: { lt: after.generatedAt } },
                { generatedAt: after.generatedAt, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      include: PAYSLIP_INCLUDE,
    });

    const page = toPage(rows, query.limit, (row) => `${row.generatedAt.toISOString()}|${row.id}`);
    return { items: page.pageRows.map((row) => toApiPayslip(row)), nextCursor: page.nextCursor };
  }

  /** One payslip this caller may see, or 404. */
  async get(viewer: SignedInUser, payslipId: string): Promise<ApiPayslip> {
    return toApiPayslip(await this.byId(viewer, payslipId));
  }

  /**
   * The stored file, exactly as it was written when the run locked.
   *
   * Reading it is audited by the controller rather than here, because the
   * controller is where the response actually leaves.
   */
  async pdf(
    viewer: SignedInUser,
    payslipId: string,
  ): Promise<{ bytes: Uint8Array; fileName: string; employeeId: string }> {
    const payslip = await this.byId(viewer, payslipId);
    return {
      bytes: new Uint8Array(payslip.pdf),
      fileName: payslipFileName(
        payslip.line.staffNumber,
        toIsoDate(payslip.run.period.endsOn),
        payslip.id,
        payslip.line.adjustsLineId !== null,
      ),
      employeeId: payslip.employeeId,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * One payslip, scoped to what this caller may see.
   *
   * A guard reading another guard's payslip gets 404 and not 403, so the answer
   * for "not yours" and "does not exist" are the same sentence. A 403 here would
   * tell somebody that a payslip exists, which is itself worth knowing.
   */
  private async byId(viewer: SignedInUser, payslipId: string) {
    const payslip = await this.prisma.payslip.findFirst({
      where: {
        id: payslipId,
        companyId: viewer.companyId,
        ...(viewer.role === 'GUARD' ? { employeeId: viewer.employeeId ?? '' } : {}),
      },
      include: PAYSLIP_INCLUDE,
    });
    if (payslip === null) {
      throw new NotFoundException('No payslip exists with this ID.');
    }
    return payslip;
  }

  /**
   * Refuses a filter that names a row this company does not have.
   *
   * Scoped to the company, so this answers 404 both for an id that exists
   * nowhere and for one belonging to another company — the same rule the rest
   * of the API follows, so nobody can use the difference between the two
   * answers to find out which ids exist elsewhere.
   */
  private async refuseFiltersThatNameNothing(
    viewer: SignedInUser,
    query: ListPayslipsQuery,
    employeeId: string | undefined,
  ): Promise<void> {
    const companyId = viewer.companyId;
    const [employee, run, period] = await Promise.all([
      employeeId === undefined
        ? null
        : this.prisma.employee.findFirst({
            where: { id: employeeId, companyId },
            select: { id: true },
          }),
      query.runId === undefined
        ? null
        : this.prisma.payrollRun.findFirst({
            where: { id: query.runId, companyId },
            select: { id: true },
          }),
      query.periodId === undefined
        ? null
        : this.prisma.payrollPeriod.findFirst({
            where: { id: query.periodId, companyId },
            select: { id: true },
          }),
    ]);
    if (employeeId !== undefined && employee === null) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    if (query.runId !== undefined && run === null) {
      throw new NotFoundException('No payroll run exists with this ID.');
    }
    if (query.periodId !== undefined && period === null) {
      throw new NotFoundException('No payroll month exists with this ID.');
    }
  }

  /** The moment and id a cursor points just past, or a clear 400. */
  private payslipCursor(cursor: string): { generatedAt: Date; id: string } {
    const value = decodeCursor(cursor);
    const [moment, id] = (value ?? '').split('|');
    const generatedAt = moment === undefined ? undefined : new Date(moment);
    if (generatedAt === undefined || Number.isNaN(generatedAt.getTime()) || !looksLikeAnId(id)) {
      throw badCursor();
    }
    return { generatedAt, id };
  }
}

/**
 * A payslip as the contract describes it.
 *
 * Only `runStatus` and `paidAt` are read live from the run. Everything else
 * comes from the frozen line, so what a worker saw last year is what they see
 * today.
 */
function toApiPayslip(row: {
  id: string;
  lineId: string;
  runId: string;
  employeeId: string;
  pdfSizeBytes: number;
  pdfSha256: string;
  generatedAt: Date;
  line: {
    staffNumber: string;
    fullName: string;
    daysInPeriod: number;
    daysEmployed: number;
    basicMonthlyPesewas: number;
    basicPesewas: number;
    scheduledMinutes: number;
    regularMinutes: number;
    overtimeMinutes: number;
    punchedMinutes: number;
    overtimeHourlyPesewas: number;
    overtimePesewas: number;
    taxableAllowancePesewas: number;
    nonTaxableAllowancePesewas: number;
    grossPesewas: number;
    taxableGrossPesewas: number;
    ssnitEmployeePesewas: number;
    ssnitEmployerPesewas: number;
    chargeableIncomePesewas: number;
    payePesewas: number;
    otherDeductionsPesewas: number;
    netPayPesewas: number;
    taxTableId: string;
    taxYear: number;
    adjustsLineId: string | null;
    adjustmentNote: string | null;
  };
  run: {
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'LOCKED' | 'PAID' | 'REJECTED';
    paidAt: Date | null;
    periodId: string;
    period: { startsOn: Date; endsOn: Date };
    taxTable: { ssnitEmployeeBasisPoints: number; ssnitEmployerBasisPoints: number };
  };
}): ApiPayslip {
  return {
    id: row.id,
    lineId: row.lineId,
    runId: row.runId,
    periodId: row.run.periodId,
    periodStartDate: toIsoDate(row.run.period.startsOn),
    periodEndDate: toIsoDate(row.run.period.endsOn),
    employee: {
      id: row.employeeId,
      staffNumber: row.line.staffNumber,
      fullName: row.line.fullName,
    },
    // The two live figures: whether the money has actually gone, and when.
    runStatus: row.run.status,
    paidAt: row.run.paidAt?.toISOString() ?? null,
    basicMonthlyPesewas: row.line.basicMonthlyPesewas,
    daysInPeriod: row.line.daysInPeriod,
    daysEmployed: row.line.daysEmployed,
    basicPesewas: row.line.basicPesewas,
    scheduledMinutes: row.line.scheduledMinutes,
    regularMinutes: row.line.regularMinutes,
    overtimeMinutes: row.line.overtimeMinutes,
    punchedMinutes: row.line.punchedMinutes,
    overtimeHourlyPesewas: row.line.overtimeHourlyPesewas,
    overtimePesewas: row.line.overtimePesewas,
    taxableAllowancePesewas: row.line.taxableAllowancePesewas,
    nonTaxableAllowancePesewas: row.line.nonTaxableAllowancePesewas,
    grossPesewas: row.line.grossPesewas,
    taxableGrossPesewas: row.line.taxableGrossPesewas,
    ssnitEmployeeBasisPoints: row.run.taxTable.ssnitEmployeeBasisPoints,
    ssnitEmployeePesewas: row.line.ssnitEmployeePesewas,
    ssnitEmployerBasisPoints: row.run.taxTable.ssnitEmployerBasisPoints,
    ssnitEmployerPesewas: row.line.ssnitEmployerPesewas,
    chargeableIncomePesewas: row.line.chargeableIncomePesewas,
    payePesewas: row.line.payePesewas,
    otherDeductionsPesewas: row.line.otherDeductionsPesewas,
    netPayPesewas: row.line.netPayPesewas,
    taxTableId: row.line.taxTableId,
    taxYear: row.line.taxYear,
    adjustsLineId: row.line.adjustsLineId,
    adjustmentNote: row.line.adjustmentNote,
    pdfGeneratedAt: row.generatedAt.toISOString(),
    pdfSizeBytes: row.pdfSizeBytes,
    pdfSha256: row.pdfSha256,
  };
}
