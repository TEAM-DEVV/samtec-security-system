/**
 * The company's own record: its name, and the bank account its payroll is
 * paid from.
 *
 * This module owns the four new columns on `companies` (`bank_name`,
 * `branch`, `account_name`, `account_number`) and nothing else touches them.
 * Payroll asks `payingAccountFor` for the payment receipt instead of reading
 * the columns itself, the same rule that keeps every module writing only its
 * own tables.
 *
 * **The account number is never read back in full.** `getBankAccount` and
 * `payingAccountFor` both mask it to its last four digits before it leaves
 * this service, it is never put in a log, an error message or a URL, and the
 * audit entry for a change names only which fields moved.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { CompanyBankAccount } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { maskToLastFourOrNull } from '../../common/masking.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import type { SetBankAccountBody } from './company.schemas.js';

/** What the payment receipt needs to name the account it was paid from. */
export interface PayingAccount {
  companyName: string;
  bankName: string | null;
  branch: string | null;
  /** Masked to its last four digits, like everywhere else this is shown. */
  accountNumberMasked: string | null;
}

type CompanyRow = {
  name: string;
  bankName: string | null;
  branch: string | null;
  accountName: string | null;
  accountNumber: string | null;
};

const BANK_ACCOUNT_FIELDS = ['bankName', 'branch', 'accountName', 'accountNumber'] as const;

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The company's name and its bank account, the account number masked. */
  async getBankAccount(viewer: SignedInUser): Promise<CompanyBankAccount> {
    return toApiBankAccount(await this.byId(viewer.companyId));
  }

  /**
   * Replaces the company's bank account. All four fields together: send
   * `null` for anything the company does not have, so a field is only ever
   * cleared on purpose, the same rule `employee-pay.service.ts` follows for
   * `employee_payment_details`.
   *
   * Audited as `company.bank_account_changed`, naming only which fields
   * moved — never a value, and never an account number, not even the one
   * being replaced.
   */
  async setBankAccount(
    viewer: SignedInUser,
    body: SetBankAccountBody,
  ): Promise<CompanyBankAccount> {
    const before = await this.byId(viewer.companyId);
    const changedFields = BANK_ACCOUNT_FIELDS.filter((field) => before[field] !== body[field]);

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.company.update({
        where: { id: viewer.companyId },
        data: {
          bankName: body.bankName,
          branch: body.branch,
          accountName: body.accountName,
          accountNumber: body.accountNumber,
        },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'company.bank_account_changed',
          entityType: 'company',
          entityId: viewer.companyId,
          detail: { changedFields: changedFields.join(',') },
        },
        tx,
      );
      return updated;
    });
    return toApiBankAccount(after);
  }

  /**
   * The account the bank file is paid from, for the payment receipt
   * (`payroll-approval.service.ts`). Already masked: payroll never reads an
   * account number in full, and never will — it asks this module instead of
   * touching `companies` itself.
   */
  async payingAccountFor(companyId: string): Promise<PayingAccount> {
    const company = await this.byId(companyId);
    return {
      companyName: company.name,
      bankName: company.bankName,
      branch: company.branch,
      accountNumberMasked: maskToLastFourOrNull(company.accountNumber),
    };
  }

  /**
   * One company, by its own ID.
   *
   * In practice this can never miss: `companyId` comes from the caller's own
   * access token, which the sign-in wall only issues for a company that
   * exists. The check exists so a corrupted token answers a clear error
   * instead of a crash two lines further down.
   */
  private async byId(companyId: string, tx: Prisma.TransactionClient = this.prisma): Promise<CompanyRow> {
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        bankName: true,
        branch: true,
        accountName: true,
        accountNumber: true,
      },
    });
    if (company === null) {
      throw new NotFoundException('No company exists with this ID.');
    }
    return company;
  }
}

function toApiBankAccount(company: CompanyRow): CompanyBankAccount {
  return {
    companyName: company.name,
    bankName: company.bankName,
    branch: company.branch,
    accountName: company.accountName,
    accountNumberMasked: maskToLastFourOrNull(company.accountNumber),
  };
}
