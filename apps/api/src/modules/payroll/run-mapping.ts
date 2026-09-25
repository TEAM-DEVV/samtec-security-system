/**
 * Turns payroll run and line rows into the shapes the contract promises.
 *
 * Pure functions, like `payroll-mapping.ts`, and separate from it because these
 * two carry the money: every figure a worker could dispute passes through here,
 * so it is worth being able to prove field by field what comes out.
 *
 * A run stores no totals. They are the exact sums of its lines, worked out on
 * the way past, because a stored total is a second version of the truth that
 * can drift from the first — and the lines are frozen the moment the run is
 * submitted, so the sum can never change under a reader either.
 */
import type {
  PayrollLine as ApiPayrollLine,
  PayrollRun as ApiPayrollRun,
  EmployeeRef,
  PayrollRunExclusion,
  PayrollRunStatus,
  PayrollRunTotals,
  PayrollStatutorySummary,
} from '@samtec/contracts';
import { toIsoDate } from '../../common/dates.js';
import type {
  PayrollLine,
  PayrollPeriod,
  PayrollRun,
  TaxTable,
} from '../../generated/prisma/client.js';

/** A line always travels with the person it pays. */
export type LineWithEmployee = PayrollLine & { adjustsLine: { runId: string } | null };

/** Everything a run needs to describe itself, without reading its lines twice. */
export interface RunContext {
  period: Pick<PayrollPeriod, 'startsOn' | 'endsOn'>;
  taxYear: number;
  lines: readonly PayrollLine[];
}

/** Nothing at all, for a run whose lines have not been read. */
const NO_TOTALS: PayrollRunTotals = {
  totalBasicPesewas: 0,
  totalOvertimePesewas: 0,
  totalTaxableAllowancePesewas: 0,
  totalNonTaxableAllowancePesewas: 0,
  totalGrossPesewas: 0,
  totalSsnitEmployeePesewas: 0,
  totalPayePesewas: 0,
  totalOtherDeductionsPesewas: 0,
  totalNetPayPesewas: 0,
  totalSsnitEmployerPesewas: 0,
};

/**
 * The exact sums of a run's lines.
 *
 * No figure here has a floor. A run made only of corrections can be negative in
 * every column, and a total clamped at zero would hide money being taken back.
 */
export function totalsOf(lines: readonly PayrollLine[]): PayrollRunTotals {
  const totals = { ...NO_TOTALS };
  for (const line of lines) {
    totals.totalBasicPesewas += line.basicPesewas;
    totals.totalOvertimePesewas += line.overtimePesewas;
    totals.totalTaxableAllowancePesewas += line.taxableAllowancePesewas;
    totals.totalNonTaxableAllowancePesewas += line.nonTaxableAllowancePesewas;
    totals.totalGrossPesewas += line.grossPesewas;
    totals.totalSsnitEmployeePesewas += line.ssnitEmployeePesewas;
    totals.totalPayePesewas += line.payePesewas;
    totals.totalOtherDeductionsPesewas += line.otherDeductionsPesewas;
    totals.totalNetPayPesewas += line.netPayPesewas;
    totals.totalSsnitEmployerPesewas += line.ssnitEmployerPesewas;
  }
  return totals;
}

/**
 * Whoever was left out of the run, read back from the snapshot taken when it
 * was calculated.
 *
 * It is stored as JSON and can never be changed afterwards, so this reads
 * defensively: a shape nobody expected becomes an empty list rather than an
 * error, because a run that cannot be read at all is worse than a run whose
 * exclusion list is missing. The insert trigger makes that unreachable, which
 * is exactly why it should never be the thing that breaks a payslip.
 */
export function exclusionsOf(stored: unknown): PayrollRunExclusion[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  const exclusions: PayrollRunExclusion[] = [];
  for (const item of stored) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const row = item as { employee?: unknown; reason?: unknown };
    const employee = row.employee as EmployeeRef | undefined;
    if (
      employee === undefined ||
      typeof employee.id !== 'string' ||
      (row.reason !== 'SUSPENDED' && row.reason !== 'NO_PAY_TERMS')
    ) {
      continue;
    }
    exclusions.push({ employee, reason: row.reason });
  }
  return exclusions;
}

/** One payroll run, with the totals and counts worked out from its lines. */
export function toApiRun(row: PayrollRun, context: RunContext): ApiPayrollRun {
  const employees = new Set(context.lines.map((line) => line.employeeId));
  const adjustments = context.lines.filter((line) => line.adjustsLineId !== null);
  return {
    id: row.id,
    periodId: row.periodId,
    periodStartDate: toIsoDate(context.period.startsOn),
    periodEndDate: toIsoDate(context.period.endsOn),
    status: row.status,
    taxTableId: row.taxTableId,
    taxYear: context.taxYear,
    totals: totalsOf(context.lines),
    summary: {
      lineCount: context.lines.length,
      employeeCount: employees.size,
      adjustmentLineCount: adjustments.length,
      excluded: exclusionsOf(row.excludedEmployees),
    },
    calculatedAt: row.calculatedAt.toISOString(),
    calculatedByUserId: row.calculatedByUserId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submittedByUserId: row.submittedByUserId,
    submissionNote: row.submissionNote,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    approvalNote: row.approvalNote,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedByUserId: row.rejectedByUserId,
    rejectionReason: row.rejectionReason,
    paidAt: row.paidAt?.toISOString() ?? null,
    paidByUserId: row.paidByUserId,
    paidOn: row.paidOn === null ? null : toIsoDate(row.paidOn),
    paymentReference: row.paymentReference,
    paymentNote: row.paymentNote,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One line of a run: everything that was true when it was calculated, copied
 * into the row itself so a locked run can be re-checked years later without
 * reading anything else (decision 16).
 */
export function toApiLine(row: LineWithEmployee): ApiPayrollLine {
  return {
    id: row.id,
    runId: row.runId,
    employee: { id: row.employeeId, staffNumber: row.staffNumber, fullName: row.fullName },
    employeeStatus: row.employeeStatus,
    adjustsLineId: row.adjustsLineId,
    adjustsRunId: row.adjustsLine?.runId ?? null,
    adjustmentNote: row.adjustmentNote,
    payTermsId: row.payTermsId,
    payTermsEffectiveFrom: toIsoDate(row.payTermsEffectiveFrom),
    basicMonthlyPesewas: row.basicMonthlyPesewas,
    overtimeHourlyPesewas: row.overtimeHourlyPesewas,
    daysInPeriod: row.daysInPeriod,
    daysEmployed: row.daysEmployed,
    basicPesewas: row.basicPesewas,
    scheduledMinutes: row.scheduledMinutes,
    punchedMinutes: row.punchedMinutes,
    regularMinutes: row.regularMinutes,
    overtimeMinutes: row.overtimeMinutes,
    overtimePesewas: row.overtimePesewas,
    taxableAllowancePesewas: row.taxableAllowancePesewas,
    nonTaxableAllowancePesewas: row.nonTaxableAllowancePesewas,
    grossPesewas: row.grossPesewas,
    taxableGrossPesewas: row.taxableGrossPesewas,
    ssnitEmployeePesewas: row.ssnitEmployeePesewas,
    ssnitEmployerPesewas: row.ssnitEmployerPesewas,
    ssnitTier1Pesewas: row.ssnitTier1Pesewas,
    ssnitTier2Pesewas: row.ssnitTier2Pesewas,
    chargeableIncomePesewas: row.chargeableIncomePesewas,
    payePesewas: row.payePesewas,
    otherDeductionsPesewas: row.otherDeductionsPesewas,
    netPayPesewas: row.netPayPesewas,
    taxTableId: row.taxTableId,
    taxYear: row.taxYear,
  };
}

/**
 * What the company owes the state for this run, with the percentages it was
 * worked out at printed beside the amounts.
 *
 * The rates are read from the version the run used, not from today's version,
 * because a summary of a run from two budgets ago must still show the rates of
 * its own time.
 */
export function toStatutorySummary(
  run: PayrollRun,
  period: Pick<PayrollPeriod, 'startsOn' | 'endsOn'>,
  table: TaxTable,
  lines: readonly PayrollLine[],
  generatedAt: Date,
): PayrollStatutorySummary {
  const totals = totalsOf(lines);
  const tier1 = lines.reduce((sum, line) => sum + line.ssnitTier1Pesewas, 0);
  const tier2 = lines.reduce((sum, line) => sum + line.ssnitTier2Pesewas, 0);
  return {
    runId: run.id,
    status: run.status as PayrollRunStatus,
    periodId: run.periodId,
    periodStartDate: toIsoDate(period.startsOn),
    periodEndDate: toIsoDate(period.endsOn),
    taxTableId: table.id,
    taxYear: table.taxYear,
    employeeCount: new Set(lines.map((line) => line.employeeId)).size,
    totalBasicPesewas: totals.totalBasicPesewas,
    ssnitEmployeeBasisPoints: table.ssnitEmployeeBasisPoints,
    totalSsnitEmployeePesewas: totals.totalSsnitEmployeePesewas,
    ssnitEmployerBasisPoints: table.ssnitEmployerBasisPoints,
    totalSsnitEmployerPesewas: totals.totalSsnitEmployerPesewas,
    // What is actually remitted: the worker's share and the company's together.
    totalSsnitPesewas: totals.totalSsnitEmployeePesewas + totals.totalSsnitEmployerPesewas,
    ssnitTier1BasisPoints: table.ssnitTier1BasisPoints,
    totalSsnitTier1Pesewas: tier1,
    ssnitTier2BasisPoints: table.ssnitTier2BasisPoints,
    totalSsnitTier2Pesewas: tier2,
    totalPayePesewas: totals.totalPayePesewas,
    generatedAt: generatedAt.toISOString(),
  };
}
