/**
 * The life of a payroll run after it is calculated: submitted, approved or
 * rejected, then marked paid — and the bank file that comes out of it.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decisions 16, 17, 22 and 23.
 *
 * **The maker is never the checker.** Whoever calculated or submitted a run may
 * never approve or reject it. This service answers 403 for that, the database
 * refuses it with a `CHECK`, and the run records all four names so the refusal
 * can be shown rather than asserted. One of those guards on its own would be a
 * promise; three is a control.
 *
 * Every state change rides on a conditional `updateMany` inside a transaction,
 * so two people acting at the same moment get a clear 409 rather than one of
 * them quietly winning.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PayrollRun as ApiPayrollRun } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import {
  DEFAULT_PRESENCE_TOLERANCE_MINUTES,
  paidBeyondPresence,
} from '../../common/paid-beyond-presence.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AttendanceFactsService } from '../attendance/attendance-facts.service.js';
import { AuditService } from '../identity/audit.service.js';
import { orConflict } from './already-exists.js';
import { bankExportCsv, netPerEmployee } from './bank-export.js';
import type {
  ApproveRunBody,
  MarkPaidBody,
  RejectRunBody,
  SubmitRunBody,
} from './payroll.schemas.js';
import { buildPayslipPdf } from './payslip-pdf.js';
import { exclusionsOf, toApiRun } from './run-mapping.js';
import { buildRunSummaryPdf, runSummaryFileName } from './run-summary-pdf.js';

@Injectable()
export class PayrollApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceFactsService,
  ) {}

  /**
   * Sends a draft to a checker.
   *
   * Only the person who calculated it may submit it, so the run carries one
   * name for "who made this" rather than two people sharing the responsibility.
   *
   * It also refuses a run that pays for hours nobody worked — rule R3. The
   * hours are **counted again** from the attendance tables here, not read off
   * the line: the line's own minutes were written by the same run that paid
   * them, so comparing a line with itself would prove nothing. Recounting is
   * what catches a run built on shifts that have been disputed or voided since
   * it was calculated.
   */
  async submit(viewer: SignedInUser, runId: string, body: SubmitRunBody): Promise<ApiPayrollRun> {
    const run = await this.byId(viewer, runId);
    if (run.calculatedByUserId !== viewer.userId) {
      throw new ForbiddenException(
        'Only the person who calculated this run may submit it, so one name answers for the figures.',
      );
    }
    if (run.status !== 'DRAFT') {
      throw new ConflictException('Only a draft can be submitted.');
    }
    await this.refuseHoursNobodyWorked(viewer, run);

    return this.move(viewer, runId, {
      from: 'DRAFT',
      to: 'PENDING_APPROVAL',
      data: {
        submittedByUserId: viewer.userId,
        submittedAt: new Date(),
        submissionNote: body.note ?? null,
      },
      clash: 'This run is no longer a draft, so it cannot be submitted.',
      action: 'payroll.run_submitted',
    });
  }

  /**
   * Approves a run, which freezes it and makes a payslip for every line.
   *
   * The payslips are written in the same transaction as the approval. A locked
   * run without its payslips would be pay somebody could not see a statement
   * for, and half-locked payroll is worse than none.
   */
  async approve(viewer: SignedInUser, runId: string, body: ApproveRunBody): Promise<ApiPayrollRun> {
    const run = await this.byId(viewer, runId);
    this.refuseTheirOwnWork(viewer, run, 'approve');
    if (run.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('Only a run waiting for approval can be approved.');
    }

    const approvedAt = new Date();
    const moved = await this.prisma.$transaction(async (tx) => {
      // A month takes at most one approved run, and the database holds that
      // with a partial unique index (decision 17). Approving a second one is
      // therefore a duplicate row rather than a failed condition, so it has to
      // be caught as one or the caller gets a 500 for a legitimate refusal.
      const changed = await orConflict(
        () =>
          tx.payrollRun.updateMany({
            where: { id: runId, companyId: viewer.companyId, status: 'PENDING_APPROVAL' },
            data: {
              status: 'LOCKED',
              approvedByUserId: viewer.userId,
              approvedAt,
              approvalNote: body.note ?? null,
            },
          }),
        'This month already has an approved run. Reject this one, or unpick the other first.',
      );
      if (changed.count !== 1) {
        throw new ConflictException('Somebody has already decided about this run.');
      }

      await this.writePayslips(tx, viewer, run);

      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.run_approved',
          entityType: 'payroll_run',
          entityId: runId,
          detail: { periodId: run.periodId, submittedByUserId: run.submittedByUserId },
        },
        tx,
      );
      return this.readForApi(tx, viewer, runId);
    });
    return moved;
  }

  /** Sends a run back. A rejection is final: the answer is a new draft. */
  async reject(viewer: SignedInUser, runId: string, body: RejectRunBody): Promise<ApiPayrollRun> {
    const run = await this.byId(viewer, runId);
    this.refuseTheirOwnWork(viewer, run, 'reject');
    if (run.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('Only a run waiting for approval can be rejected.');
    }
    return this.move(viewer, runId, {
      from: 'PENDING_APPROVAL',
      to: 'REJECTED',
      data: {
        rejectedByUserId: viewer.userId,
        rejectedAt: new Date(),
        rejectionReason: body.reason,
      },
      clash: 'Somebody has already decided about this run.',
      action: 'payroll.run_rejected',
    });
  }

  /**
   * Records that the money has gone.
   *
   * No second person is needed here, because the payment has already happened:
   * this writes down a fact rather than authorising anything. It works after the
   * month is closed for the same reason — the bank does not wait for the books.
   */
  async markPaid(viewer: SignedInUser, runId: string, body: MarkPaidBody): Promise<ApiPayrollRun> {
    const run = await this.byId(viewer, runId);
    if (run.status !== 'LOCKED') {
      throw new ConflictException(
        run.status === 'PAID'
          ? 'This run is already marked paid.'
          : 'Only an approved run can be marked paid.',
      );
    }
    return this.move(viewer, runId, {
      from: 'LOCKED',
      to: 'PAID',
      data: {
        paidByUserId: viewer.userId,
        paidAt: new Date(),
        paidOn: new Date(`${body.paidOn}T00:00:00Z`),
        paymentReference: body.paymentReference ?? null,
        paymentNote: body.note ?? null,
      },
      clash: 'This run is no longer waiting to be paid.',
      action: 'payroll.run_marked_paid',
    });
  }

  /**
   * The bank file for an approved run.
   *
   * Reading it is audited, because this is the one download that carries every
   * worker's account number. The audit entry records who asked and for which
   * run, never a single digit of what they got.
   */
  async bankExport(
    viewer: SignedInUser,
    runId: string,
  ): Promise<{ csv: string; fileName: string }> {
    const run = await this.byId(viewer, runId);
    if (run.status !== 'LOCKED' && run.status !== 'PAID') {
      throw new ConflictException('A bank file exists only once the run has been approved.');
    }

    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId },
      select: { employeeId: true, staffNumber: true, fullName: true, netPayPesewas: true },
    });
    const rows = netPerEmployee(lines);
    const details = await this.prisma.employeePaymentDetails.findMany({
      where: { companyId: viewer.companyId, employeeId: { in: rows.map((row) => row.employeeId) } },
    });

    const csv = bankExportCsv(
      rows,
      new Map(details.map((row) => [row.employeeId, row])),
      { endDate: toIsoDate(run.period.endsOn) },
      run.approvedAt,
    );

    await this.audit.record({
      companyId: viewer.companyId,
      actorUserId: viewer.userId,
      action: 'payroll.bank_file_downloaded',
      entityType: 'payroll_run',
      entityId: runId,
      detail: {
        periodId: run.periodId,
        rowCount: rows.filter((row) => row.netPayPesewas > 0).length,
      },
    });

    return { csv, fileName: `payroll-run-${runId}.csv` };
  }

  /**
   * A one-page summary of the run, for filing.
   *
   * It names no individual's pay, so unlike the bank file it can be shared
   * without handling anybody's salary — and unlike a payslip, it is built when
   * it is asked for rather than frozen, because it is a picture of the run
   * rather than evidence given to a worker.
   */
  async summaryPdf(
    viewer: SignedInUser,
    runId: string,
  ): Promise<{ bytes: Uint8Array; fileName: string }> {
    const run = await this.byId(viewer, runId);
    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId },
    });
    const sum = (pick: (line: (typeof lines)[number]) => number) =>
      lines.reduce((total, line) => total + pick(line), 0);

    const built = buildRunSummaryPdf({
      periodStartDate: toIsoDate(run.period.startsOn),
      periodEndDate: toIsoDate(run.period.endsOn),
      status: run.status,
      employeeCount: new Set(lines.map((line) => line.employeeId)).size,
      lineCount: lines.length,
      grossPesewas: sum((line) => line.grossPesewas),
      ssnitEmployeePesewas: sum((line) => line.ssnitEmployeePesewas),
      payePesewas: sum((line) => line.payePesewas),
      otherDeductionsPesewas: sum((line) => line.otherDeductionsPesewas),
      netPayPesewas: sum((line) => line.netPayPesewas),
      ssnitEmployerPesewas: sum((line) => line.ssnitEmployerPesewas),
      ssnitEmployeeBasisPoints: run.taxTable.ssnitEmployeeBasisPoints,
      ssnitEmployerBasisPoints: run.taxTable.ssnitEmployerBasisPoints,
      taxYear: run.taxTable.taxYear,
      approvedAt: run.approvedAt?.toISOString() ?? null,
      paidOn: run.paidOn === null ? null : toIsoDate(run.paidOn),
      excluded: exclusionsOf(run.excludedEmployees).map((left) => ({
        staffNumber: left.employee.staffNumber,
        fullName: left.employee.fullName,
        reason: left.reason === 'SUSPENDED' ? 'suspended' : 'no pay terms on file',
      })),
    });

    return { bytes: built.bytes, fileName: runSummaryFileName(toIsoDate(run.period.endsOn)) };
  }

  // ---------------------------------------------------------------------------

  /**
   * Refuses to let somebody decide about their own work.
   *
   * Both the submitter and the calculator are checked, so a maker cannot route
   * around the rule by having a colleague press submit for them. The same
   * comparison is a `CHECK` in the database; this one exists so the answer is
   * 403 with a sentence rather than a 500 from a constraint.
   */
  private refuseTheirOwnWork(
    viewer: SignedInUser,
    run: { submittedByUserId: string | null; calculatedByUserId: string },
    what: 'approve' | 'reject',
  ): void {
    if (run.submittedByUserId === viewer.userId || run.calculatedByUserId === viewer.userId) {
      throw new ForbiddenException(
        `You worked on this run, so somebody else must ${what} it. That is the whole point of a second pair of eyes.`,
      );
    }
  }

  /**
   * Rule R3 at the gate: a run may not be submitted if it pays anybody for
   * hours the attendance records do not support.
   *
   * The tolerance is the fixed sixty-minute floor, on purpose. Detection's own
   * tolerance is a number an ADMIN can tune, but that number lives in
   * detection's table and payroll may not read it — so the two are allowed to
   * differ, and the difference is written down: this gate is the floor, and the
   * sweep may be stricter but never looser in what it refuses.
   */
  private async refuseHoursNobodyWorked(
    viewer: SignedInUser,
    run: { id: string; period: { startsOn: Date; endsOn: Date } },
  ): Promise<void> {
    const lines = await this.prisma.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId: run.id },
      select: {
        employeeId: true,
        staffNumber: true,
        regularMinutes: true,
        overtimeMinutes: true,
      },
    });
    if (lines.length === 0) {
      return;
    }

    // Counted afresh, not read off the line: the line's own minutes were
    // written by this same run, so comparing them with themselves would prove
    // nothing. This is what catches a shift disputed or voided since.
    const segments = await this.attendance.payableSegmentsByEmployee(
      viewer.companyId,
      run.period,
      lines.map((line) => line.employeeId),
    );

    const unsupported: string[] = [];
    for (const line of lines) {
      const present = (segments.get(line.employeeId) ?? []).reduce(
        (total, day) => total + day.workedMinutes,
        0,
      );
      const beyond = paidBeyondPresence(
        line.regularMinutes + line.overtimeMinutes,
        present,
        DEFAULT_PRESENCE_TOLERANCE_MINUTES,
      );
      if (beyond > 0) {
        unsupported.push(line.staffNumber);
      }
    }

    if (unsupported.length > 0) {
      throw new ConflictException(
        `This run pays for hours the attendance records do not support, for ${unsupported.length} ` +
          `worker${unsupported.length === 1 ? '' : 's'} (${unsupported.slice(0, 5).join(', ')}` +
          `${unsupported.length > 5 ? ', and more' : ''}). Settle the shifts in the exception queue, ` +
          'then calculate the run again.',
      );
    }
  }

  /** One payslip per line, written when the run locks and never again. */
  private async writePayslips(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
    run: {
      id: string;
      taxTable: { ssnitEmployeeBasisPoints: number; ssnitEmployerBasisPoints: number };
      period: { startsOn: Date; endsOn: Date };
    },
  ): Promise<void> {
    const lines = await tx.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId: run.id },
    });
    for (const line of lines) {
      const built = buildPayslipPdf({
        staffNumber: line.staffNumber,
        fullName: line.fullName,
        periodStartDate: toIsoDate(run.period.startsOn),
        periodEndDate: toIsoDate(run.period.endsOn),
        daysInPeriod: line.daysInPeriod,
        daysEmployed: line.daysEmployed,
        basicMonthlyPesewas: line.basicMonthlyPesewas,
        basicPesewas: line.basicPesewas,
        overtimeHourlyPesewas: line.overtimeHourlyPesewas,
        overtimeMinutes: line.overtimeMinutes,
        overtimePesewas: line.overtimePesewas,
        taxableAllowancePesewas: line.taxableAllowancePesewas,
        nonTaxableAllowancePesewas: line.nonTaxableAllowancePesewas,
        grossPesewas: line.grossPesewas,
        taxableGrossPesewas: line.taxableGrossPesewas,
        ssnitEmployeeBasisPoints: run.taxTable.ssnitEmployeeBasisPoints,
        ssnitEmployeePesewas: line.ssnitEmployeePesewas,
        ssnitEmployerBasisPoints: run.taxTable.ssnitEmployerBasisPoints,
        ssnitEmployerPesewas: line.ssnitEmployerPesewas,
        chargeableIncomePesewas: line.chargeableIncomePesewas,
        payePesewas: line.payePesewas,
        otherDeductionsPesewas: line.otherDeductionsPesewas,
        netPayPesewas: line.netPayPesewas,
        taxYear: line.taxYear,
        adjustmentNote: line.adjustmentNote,
      });
      await tx.payslip.create({
        data: {
          companyId: viewer.companyId,
          runId: run.id,
          lineId: line.id,
          employeeId: line.employeeId,
          pdf: Buffer.from(built.bytes),
          pdfSizeBytes: built.sizeBytes,
          pdfSha256: built.sha256,
        },
      });
    }
  }

  /** One forward step, with the audit entry, in one transaction. */
  private async move(
    viewer: SignedInUser,
    runId: string,
    step: {
      from: 'DRAFT' | 'PENDING_APPROVAL' | 'LOCKED';
      to: 'PENDING_APPROVAL' | 'LOCKED' | 'PAID' | 'REJECTED';
      data: Prisma.PayrollRunUpdateManyMutationInput;
      clash: string;
      action: string;
    },
  ): Promise<ApiPayrollRun> {
    return this.prisma.$transaction(async (tx) => {
      // The condition rides on the update, so two people acting at once get a
      // clear answer instead of one of them silently winning.
      const changed = await tx.payrollRun.updateMany({
        where: { id: runId, companyId: viewer.companyId, status: step.from },
        data: { ...step.data, status: step.to },
      });
      if (changed.count !== 1) {
        throw new ConflictException(step.clash);
      }
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: step.action,
          entityType: 'payroll_run',
          entityId: runId,
          detail: { from: step.from, to: step.to },
        },
        tx,
      );
      return this.readForApi(tx, viewer, runId);
    });
  }

  /** The run as the contract describes it, read inside a transaction. */
  private async readForApi(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
    runId: string,
  ): Promise<ApiPayrollRun> {
    const run = await tx.payrollRun.findFirst({
      where: { id: runId, companyId: viewer.companyId },
      include: {
        period: { select: { startsOn: true, endsOn: true } },
        taxTable: { select: { taxYear: true } },
      },
    });
    if (run === null) {
      throw new NotFoundException('No payroll run exists with this ID.');
    }
    const lines = await tx.payrollLine.findMany({
      where: { companyId: viewer.companyId, runId },
    });
    return toApiRun(run, { period: run.period, taxYear: run.taxTable.taxYear, lines });
  }

  /** One run of this company, with what these decisions need, or 404. */
  private async byId(viewer: SignedInUser, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, companyId: viewer.companyId },
      include: {
        period: { select: { startsOn: true, endsOn: true, status: true } },
        taxTable: true,
      },
    });
    if (run === null) {
      throw new NotFoundException('No payroll run exists with this ID.');
    }
    return run;
  }
}
