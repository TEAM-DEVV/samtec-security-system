/**
 * What a worker is paid, and where the money is sent.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decisions 1, 22 and 23.
 *
 * Two shapes with two very different habits:
 *
 * - **Pay terms are history.** A change in pay is a new row with the day it
 *   starts, never an edit — so a run calculated last month still shows the
 *   figures that were true last month. The database refuses an update outright.
 * - **Payment details are a current address.** They are edited in place,
 *   because only the latest destination matters, and they are the one payroll
 *   shape that is personal data in the sense of Act 843. They never appear in
 *   a list, a log or an error message.
 *
 * This module never writes the `employees` table. It asks the workforce
 * module whether a worker exists, which also decides the 404.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import type {
  EmployeePaymentDetails as ApiPaymentDetails,
  EmployeePayTerms as ApiPayTerms,
  EmployeePayTermsList,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { fromIsoDate, toIsoDate } from '../../common/dates.js';
import { toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type {
  ListPayTermsQuery,
  SetPaymentDetailsBody,
  SetPayTermsBody,
} from './payroll.schemas.js';
import { pageBefore } from './payroll-cursor.js';
import { toApiPaymentDetails, toApiPayTerms } from './payroll-mapping.js';

@Injectable()
export class EmployeePayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  /**
   * One worker's pay history, newest first.
   *
   * `effectiveOn` asks a different question: not the whole history but which
   * row applied on one day, so it returns at most one item. That is exactly
   * what a payroll run needs when it works out a month.
   */
  async listPayTerms(
    viewer: SignedInUser,
    employeeId: string,
    query: ListPayTermsQuery,
  ): Promise<EmployeePayTermsList> {
    await this.employees.statusOf(viewer.companyId, employeeId, this.prisma);

    if (query.effectiveOn !== undefined) {
      const row = await this.prisma.employeePayTerms.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId,
          effectiveFrom: { lte: fromIsoDate(query.effectiveOn) },
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      return { items: row === null ? [] : [toApiPayTerms(row)], nextCursor: null };
    }

    const after = pageBefore(query.cursor);
    const rows = await this.prisma.employeePayTerms.findMany({
      where: {
        companyId: viewer.companyId,
        employeeId,
        ...(after === undefined ? {} : { effectiveFrom: { lt: after } }),
      },
      orderBy: { effectiveFrom: 'desc' },
      take: query.limit + 1,
    });

    const page = toPage(rows, query.limit, (row) => toIsoDate(row.effectiveFrom));
    return { items: page.pageRows.map(toApiPayTerms), nextCursor: page.nextCursor };
  }

  /**
   * Adds a pay history row. It never changes the row before it, which is why
   * the answer is 201 and not 200: something new exists afterwards.
   */
  async setPayTerms(
    viewer: SignedInUser,
    employeeId: string,
    body: SetPayTermsBody,
  ): Promise<ApiPayTerms> {
    const effectiveFrom = fromIsoDate(body.effectiveFrom);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.employees.statusOf(viewer.companyId, employeeId, tx);

      const clash = await tx.employeePayTerms.findFirst({
        where: { companyId: viewer.companyId, employeeId, effectiveFrom },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          'This worker already has pay terms starting on that day. Pick another day, because two rows cannot start together.',
        );
      }

      const terms = await tx.employeePayTerms.create({
        data: {
          companyId: viewer.companyId,
          employeeId,
          effectiveFrom,
          basicMonthlyPesewas: body.basicMonthlyPesewas,
          overtimeHourlyPesewas: body.overtimeHourlyPesewas,
          taxableAllowancePesewas: body.taxableAllowancePesewas,
          nonTaxableAllowancePesewas: body.nonTaxableAllowancePesewas,
          otherDeductionPesewas: body.otherDeductionPesewas,
          createdByUserId: viewer.userId,
        },
      });

      // The amounts are in the audit detail on purpose: what somebody is paid
      // is the decision being recorded, and the log is append-only evidence of
      // who made it. Nothing here is personal data in the Act 843 sense.
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'payroll.pay_terms_set',
          entityType: 'employee_pay_terms',
          entityId: terms.id,
          detail: {
            employeeId,
            effectiveFrom: body.effectiveFrom,
            basicMonthlyPesewas: body.basicMonthlyPesewas,
            overtimeHourlyPesewas: body.overtimeHourlyPesewas,
            taxableAllowancePesewas: body.taxableAllowancePesewas,
            nonTaxableAllowancePesewas: body.nonTaxableAllowancePesewas,
            otherDeductionPesewas: body.otherDeductionPesewas,
          },
        },
        tx,
      );
      return terms;
    });

    return toApiPayTerms(created);
  }

  /**
   * Sets where a worker's salary is sent, replacing whatever was there.
   *
   * The audit entry records **that** the details changed and who changed them,
   * never the values — not even a hash of the account number. A Ghanaian
   * account number is at most twenty digits, so a hash of one can be worked
   * backwards on an ordinary computer in minutes; storing it would be storing
   * the number. The bank export instead compares this row's `updatedAt` with
   * the run's approval time, which answers the same question — "did the
   * destination change after somebody approved the money?" — while keeping
   * the number itself in exactly one place.
   */
  async setPaymentDetails(
    viewer: SignedInUser,
    employeeId: string,
    body: SetPaymentDetailsBody,
  ): Promise<ApiPaymentDetails> {
    const saved = await this.prisma.$transaction(async (tx) => {
      await this.employees.statusOf(viewer.companyId, employeeId, tx);

      const before = await tx.employeePaymentDetails.findUnique({
        where: { employeeId },
        select: { bankName: true, accountName: true, accountNumber: true, momoNumber: true },
      });

      const details = await tx.employeePaymentDetails.upsert({
        where: { employeeId },
        create: {
          companyId: viewer.companyId,
          employeeId,
          bankName: body.bankName,
          accountName: body.accountName,
          accountNumber: body.accountNumber,
          momoNumber: body.momoNumber,
          updatedByUserId: viewer.userId,
        },
        update: {
          bankName: body.bankName,
          accountName: body.accountName,
          accountNumber: body.accountNumber,
          momoNumber: body.momoNumber,
          updatedByUserId: viewer.userId,
        },
      });

      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action:
            before === null ? 'payroll.payment_details_added' : 'payroll.payment_details_changed',
          entityType: 'employee_payment_details',
          entityId: details.id,
          detail: {
            employeeId,
            // Which fields moved, never what they moved to.
            bankAccountChanged:
              before === null ||
              before.bankName !== body.bankName ||
              before.accountName !== body.accountName ||
              before.accountNumber !== body.accountNumber,
            momoChanged: before === null || before.momoNumber !== body.momoNumber,
          },
        },
        tx,
      );
      return details;
    });

    return toApiPaymentDetails(saved);
  }

  // ---------------------------------------------------------------------------
}
