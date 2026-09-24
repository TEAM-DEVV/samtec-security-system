/**
 * Turns payroll database rows into the shapes the contract promises.
 *
 * Pure functions: rows in, contract objects out. No database, no `this`, no
 * clock. That is what lets a unit test prove field by field what an endpoint
 * returns, including the two things easiest to get wrong — a calendar date
 * that must never become a timestamp, and a personal detail that must never
 * appear where it does not belong.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md.
 */
import type {
  EmployeePaymentDetails as ApiPaymentDetails,
  PayrollPeriod as ApiPayrollPeriod,
  EmployeePayTerms as ApiPayTerms,
  TaxTable as ApiTaxTable,
} from '@samtec/contracts';
import { toIsoDate } from '../../common/dates.js';
import type {
  EmployeePaymentDetails,
  EmployeePayTerms,
  PayrollPeriod,
  TaxBand,
  TaxTable,
} from '../../generated/prisma/client.js';

/** A tax table always travels with its bands. */
export type TaxTableWithBands = TaxTable & { bands: TaxBand[] };

/**
 * A payroll month. `lockedRunId` is the run that was approved for it, if any:
 * the database allows at most one, so the caller passes it in rather than this
 * function guessing.
 */
export function toApiPeriod(row: PayrollPeriod, lockedRunId: string | null): ApiPayrollPeriod {
  return {
    id: row.id,
    year: row.year,
    month: row.month,
    startDate: toIsoDate(row.startsOn),
    endDate: toIsoDate(row.endsOn),
    status: row.status,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedByUserId: row.closedByUserId,
    lockedRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One version of the statutory rates, with its bands in order.
 *
 * The bands are sorted here rather than relying on the query, because the
 * order is part of what the numbers mean: band 2 taxes the slice above band 1,
 * and a client that read them in another order would show the wrong rates.
 */
export function toApiTaxTable(row: TaxTableWithBands): ApiTaxTable {
  return {
    id: row.id,
    taxYear: row.taxYear,
    effectiveFrom: toIsoDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toIsoDate(row.effectiveTo),
    ssnitEmployeeBasisPoints: row.ssnitEmployeeBasisPoints,
    ssnitEmployerBasisPoints: row.ssnitEmployerBasisPoints,
    ssnitTier1BasisPoints: row.ssnitTier1BasisPoints,
    ssnitTier2BasisPoints: row.ssnitTier2BasisPoints,
    bands: [...row.bands]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((band) => ({
        ordinal: band.ordinal,
        widthPesewas: band.widthPesewas,
        rateBasisPoints: band.rateBasisPoints,
      })),
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    sourceCheckedOn: toIsoDate(row.sourceCheckedOn),
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
  };
}

/** What one worker is paid from a given day. A row is never edited, only added. */
export function toApiPayTerms(row: EmployeePayTerms): ApiPayTerms {
  return {
    id: row.id,
    employeeId: row.employeeId,
    effectiveFrom: toIsoDate(row.effectiveFrom),
    basicMonthlyPesewas: row.basicMonthlyPesewas,
    overtimeHourlyPesewas: row.overtimeHourlyPesewas,
    taxableAllowancePesewas: row.taxableAllowancePesewas,
    nonTaxableAllowancePesewas: row.nonTaxableAllowancePesewas,
    otherDeductionPesewas: row.otherDeductionPesewas,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
  };
}

/**
 * Where a worker's money is sent.
 *
 * This is the one payroll shape that is personal data in the sense of Act 843,
 * so it is returned by exactly two endpoints — the one that sets it, and the
 * bank export — and by no list. It never goes in a log or an error message.
 */
export function toApiPaymentDetails(row: EmployeePaymentDetails): ApiPaymentDetails {
  return {
    employeeId: row.employeeId,
    bankName: row.bankName,
    accountName: row.accountName,
    accountNumber: row.accountNumber,
    momoNumber: row.momoNumber,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}
