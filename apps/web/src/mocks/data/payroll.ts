import type {
  EmployeePaymentDetails,
  EmployeePayTerms,
  PayrollLine,
  PayrollPeriod,
  PayrollRun,
  PayrollRunExclusion,
  PayrollRunTotals,
  Payslip,
  TaxTable,
} from '@samtec/contracts';
import { mockEmployees } from './employees';

// Fictional pay only (see SECURITY.md). Every bank account and mobile money
// number below is made up, and no real person's pay is represented here.

/** admin@samtec.example and hr@samtec.example in data/users.ts. */
const ADMIN_USER_ID = '01927c3e-2222-7ccc-9ddd-000000000001';
const HR_USER_ID = '01927c3e-2222-7ccc-9ddd-000000000002';
/** admin2@samtec.example: the second administrator, who approves what the first prepared. */
export const OTHER_ADMIN_USER_ID = '01927c3e-2222-7ccc-9ddd-000000000005';

export const AUGUST_PERIOD_ID = '01927c3e-aaaa-7000-8000-000000000008';
export const SEPTEMBER_PERIOD_ID = '01927c3e-aaaa-7000-8000-000000000009';
const AUGUST_RUN_ID = '01927c3e-bbbb-7000-8000-000000000001';
const SEPTEMBER_RUN_ID = '01927c3e-bbbb-7000-8000-000000000002';
export const TAX_TABLE_2026_ID = '01927c3e-cccc-7000-8000-000000000001';

/**
 * The 2026 statutory rates, exactly as the design page lists them
 * (docs/plan/09-payroll-engine-ghana.md). Widths are pesewas: GHS 490 is
 * 49000. The last band has no width because it has no upper limit.
 */
export const mockTaxTable: TaxTable = {
  id: TAX_TABLE_2026_ID,
  taxYear: 2026,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  bands: [
    { ordinal: 1, widthPesewas: 49000, rateBasisPoints: 0 },
    { ordinal: 2, widthPesewas: 10000, rateBasisPoints: 500 },
    { ordinal: 3, widthPesewas: 50000, rateBasisPoints: 1000 },
    { ordinal: 4, widthPesewas: 200000, rateBasisPoints: 1750 },
    { ordinal: 5, widthPesewas: 200000, rateBasisPoints: 2500 },
    { ordinal: 6, widthPesewas: 1491000, rateBasisPoints: 3000 },
    { ordinal: 7, widthPesewas: null, rateBasisPoints: 3500 },
  ],
  sourceName: 'GRA PAYE rates 2026',
  sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
  sourceCheckedOn: '2026-01-05',
  createdAt: '2026-01-05T09:00:00Z',
  createdByUserId: ADMIN_USER_ID,
};

/** Rounds a division half-up, away from zero, so a tie never favours the company. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('A payroll period cannot be zero days long.');
  const negative = numerator < 0n;
  const size = negative ? -numerator : numerator;
  const rounded = (size * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** Basis points are hundredths of a percent: 550 is 5.5%. */
const BASIS_POINTS = 10_000n;

/**
 * What one worker is owed. Every figure is a whole number of pesewas, worked
 * out with integers only — never a float, at any step.
 *
 * The rule that matters, and the reason a payslip can be checked by hand:
 * **every figure is worked out from the figures printed beside it.** Only the
 * two amounts that need a division — the pro-rated basic and the overtime —
 * are rounded, each exactly once, half-up. Everything after that is plain
 * addition and subtraction of those already-rounded pesewas, so the parts on a
 * payslip always add up to its totals, and `netPayPesewas` always satisfies
 * the database's `CHECK`. See decision 24 in docs/plan/09-payroll-engine-ghana.md.
 *
 * Every rate comes from the tax table version passed in, never from a number
 * written into this file, because rates change with each national budget.
 */
export function calculatePay(
  terms: EmployeePayTerms,
  worked: {
    daysInPeriod: number;
    daysEmployed: number;
    regularMinutes: number;
    overtimeMinutes: number;
  },
  taxTable: TaxTable,
) {
  if (worked.daysInPeriod < 1) throw new Error('A payroll period cannot be zero days long.');
  if (taxTable.bands.length === 0) throw new Error('A tax table needs at least one band.');

  // The only two divisions in the whole calculation, each rounded once.
  const basicPesewas = Number(
    divideHalfUp(
      BigInt(terms.basicMonthlyPesewas) * BigInt(worked.daysEmployed),
      BigInt(worked.daysInPeriod),
    ),
  );
  const overtimePesewas = Number(
    divideHalfUp(BigInt(terms.overtimeHourlyPesewas) * BigInt(worked.overtimeMinutes), 60n),
  );

  // Allowances and the deduction are monthly whole pesewas, and version 1
  // pro-rates only the basic (decision 4).
  const taxableAllowancePesewas = terms.taxableAllowancePesewas;
  const nonTaxableAllowancePesewas = terms.nonTaxableAllowancePesewas;
  const otherDeductionsPesewas = terms.otherDeductionPesewas;

  const grossPesewas =
    basicPesewas + overtimePesewas + taxableAllowancePesewas + nonTaxableAllowancePesewas;
  const taxableGrossPesewas = basicPesewas + overtimePesewas + taxableAllowancePesewas;

  // Every SSNIT figure is a percentage of the basic actually paid.
  const shareOfBasic = (basisPoints: number) =>
    Number(divideHalfUp(BigInt(basicPesewas) * BigInt(basisPoints), BASIS_POINTS));
  const ssnitEmployeePesewas = shareOfBasic(taxTable.ssnitEmployeeBasisPoints);
  const ssnitEmployerPesewas = shareOfBasic(taxTable.ssnitEmployerBasisPoints);
  const ssnitTier1Pesewas = shareOfBasic(taxTable.ssnitTier1BasisPoints);
  const ssnitTier2Pesewas = shareOfBasic(taxTable.ssnitTier2BasisPoints);

  const chargeableIncomePesewas = Math.max(0, taxableGrossPesewas - ssnitEmployeePesewas);

  // Each band taxes the next slice of the chargeable income. The last band has
  // no width, so it takes whatever is left.
  let left = BigInt(chargeableIncomePesewas);
  let scaledTax = 0n;
  for (const band of [...taxTable.bands].sort((a, b) => a.ordinal - b.ordinal)) {
    if (left <= 0n) break;
    const width = band.widthPesewas === null ? left : BigInt(band.widthPesewas);
    const inBand = left < width ? left : width;
    scaledTax += inBand * BigInt(band.rateBasisPoints);
    left -= inBand;
  }
  const payePesewas = Number(divideHalfUp(scaledTax, BASIS_POINTS));

  return {
    basicPesewas,
    overtimePesewas,
    taxableAllowancePesewas,
    nonTaxableAllowancePesewas,
    grossPesewas,
    taxableGrossPesewas,
    ssnitEmployeePesewas,
    ssnitEmployerPesewas,
    ssnitTier1Pesewas,
    ssnitTier2Pesewas,
    chargeableIncomePesewas,
    payePesewas,
    otherDeductionsPesewas,
    netPayPesewas: grossPesewas - ssnitEmployeePesewas - payePesewas - otherDeductionsPesewas,
  };
}

/** Salaries by job, so the mock data reads like a real small security firm. */
const BASIC_BY_POSITION: Record<string, number> = {
  'Security Guard': 120_000,
  'Senior Security Guard': 150_000,
  'Site Supervisor': 220_000,
  'Control Room Operator': 180_000,
  'Operations Manager': 450_000,
};

/** SMT-00010 deliberately has no pay terms, so a run can show the NO_PAY_TERMS reason. */
const WITHOUT_PAY_TERMS = new Set(['SMT-00010']);

export const mockPayTerms: EmployeePayTerms[] = mockEmployees
  .filter((employee) => !WITHOUT_PAY_TERMS.has(employee.staffNumber))
  .map((employee, index) => ({
    id: `01927c3e-dddd-7000-8000-${String(index + 1).padStart(12, '0')}`,
    employeeId: employee.id,
    effectiveFrom: employee.hireDate > '2026-01-01' ? employee.hireDate : '2026-01-01',
    basicMonthlyPesewas: BASIC_BY_POSITION[employee.position] ?? 120_000,
    overtimeHourlyPesewas: 900,
    // Every third person gets a transport allowance; one in four a non-taxable one.
    taxableAllowancePesewas: index % 3 === 0 ? 15_000 : 0,
    nonTaxableAllowancePesewas: index % 4 === 0 ? 5_000 : 0,
    otherDeductionPesewas: index % 5 === 0 ? 2_000 : 0,
    createdAt: '2026-01-05T10:00:00Z',
    createdByUserId: HR_USER_ID,
  }));

/** Fictional accounts. Two workers have none, so the bank file shows who to chase. */
export const mockPaymentDetails: EmployeePaymentDetails[] = mockEmployees
  .slice(0, 10)
  .map((employee, index) => ({
    employeeId: employee.id,
    bankName: index % 3 === 2 ? null : 'GCB Bank',
    accountName: index % 3 === 2 ? null : employee.fullName,
    accountNumber: index % 3 === 2 ? null : `10${String(index + 1).padStart(11, '0')}`,
    momoNumber: index % 3 === 2 ? `+2332400000${String(index + 10).padStart(2, '0')}` : null,
    updatedAt: '2026-02-01T10:00:00Z',
    updatedByUserId: HR_USER_ID,
  }));

export const mockPeriods: PayrollPeriod[] = [
  {
    id: SEPTEMBER_PERIOD_ID,
    year: 2026,
    month: 9,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    status: 'OPEN',
    closedAt: null,
    closedByUserId: null,
    lockedRunId: null,
    createdAt: '2026-09-01T06:00:00Z',
    updatedAt: '2026-09-01T06:00:00Z',
  },
  {
    id: AUGUST_PERIOD_ID,
    year: 2026,
    month: 8,
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    status: 'CLOSED',
    closedAt: '2026-09-02T11:00:00Z',
    closedByUserId: HR_USER_ID,
    lockedRunId: AUGUST_RUN_ID,
    createdAt: '2026-08-01T06:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

/**
 * How long each worker was on shift in a month. Guards work twelve-hour
 * shifts, so a full month is 22 days of 720 minutes; two of them picked up
 * extra hours, which is where the overtime in the mock runs comes from.
 */
function workedFor(staffNumber: string, daysInPeriod: number, daysEmployed: number) {
  const fullMonth = daysEmployed >= daysInPeriod;
  const days = fullMonth ? 22 : Math.max(1, Math.round((22 * daysEmployed) / daysInPeriod));
  const scheduledMinutes = days * 720;
  const overtimeMinutes = staffNumber === 'SMT-00001' ? 600 : staffNumber === 'SMT-00005' ? 240 : 0;
  return {
    daysInPeriod,
    daysEmployed,
    scheduledMinutes,
    regularMinutes: scheduledMinutes,
    overtimeMinutes,
    punchedMinutes: scheduledMinutes + overtimeMinutes,
  };
}

/** Whole days of the period the worker was employed, counting both end days. */
export function daysEmployedIn(
  employee: { hireDate: string; terminationDate: string | null },
  startDate: string,
  endDate: string,
): number {
  const day = 86_400_000;
  const from = Math.max(
    Date.parse(`${startDate}T00:00:00Z`),
    Date.parse(`${employee.hireDate}T00:00:00Z`),
  );
  const to = Math.min(
    Date.parse(`${endDate}T00:00:00Z`),
    employee.terminationDate === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(`${employee.terminationDate}T00:00:00Z`),
  );
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return to < from ? 0 : Math.round((to - from) / day) + 1;
}

export function daysBetweenInclusive(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

export interface CalculatedRun {
  lines: PayrollLine[];
  excluded: PayrollRunExclusion[];
  totals: PayrollRunTotals;
}

/**
 * Builds a run's lines from the employees, their pay terms and the tax table,
 * following the same rules as the API: everyone employed for at least one day
 * with pay terms effective by the last day is paid, a SUSPENDED worker and
 * anyone without pay terms is left off and listed, and every input is copied
 * into the line.
 */
export function calculateRun(
  runId: string,
  period: PayrollPeriod,
  payTerms: readonly EmployeePayTerms[],
  taxTable: TaxTable,
): CalculatedRun {
  const daysInPeriod = daysBetweenInclusive(period.startDate, period.endDate);
  const lines: PayrollLine[] = [];
  const excluded: PayrollRunExclusion[] = [];

  for (const employee of mockEmployees) {
    const daysEmployed = daysEmployedIn(employee, period.startDate, period.endDate);
    if (daysEmployed === 0) continue;
    const ref = { id: employee.id, staffNumber: employee.staffNumber, fullName: employee.fullName };
    if (employee.status === 'SUSPENDED') {
      excluded.push({ employee: ref, reason: 'SUSPENDED' });
      continue;
    }
    const terms = [...payTerms]
      .filter((row) => row.employeeId === employee.id && row.effectiveFrom <= period.endDate)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!terms) {
      excluded.push({ employee: ref, reason: 'NO_PAY_TERMS' });
      continue;
    }
    const worked = workedFor(employee.staffNumber, daysInPeriod, daysEmployed);
    const money = calculatePay(terms, worked, taxTable);
    lines.push({
      id: `01927c3e-eeee-7000-8000-${runId.slice(-4)}${String(lines.length + 1).padStart(8, '0')}`,
      runId,
      employee: ref,
      employeeStatus: employee.status,
      adjustsLineId: null,
      adjustsRunId: null,
      adjustmentNote: null,
      payTermsId: terms.id,
      payTermsEffectiveFrom: terms.effectiveFrom,
      basicMonthlyPesewas: terms.basicMonthlyPesewas,
      overtimeHourlyPesewas: terms.overtimeHourlyPesewas,
      daysInPeriod: worked.daysInPeriod,
      daysEmployed: worked.daysEmployed,
      scheduledMinutes: worked.scheduledMinutes,
      punchedMinutes: worked.punchedMinutes,
      regularMinutes: worked.regularMinutes,
      overtimeMinutes: worked.overtimeMinutes,
      taxTableId: taxTable.id,
      taxYear: taxTable.taxYear,
      ...money,
    });
  }

  lines.sort((a, b) => a.employee.staffNumber.localeCompare(b.employee.staffNumber));
  return { lines, excluded, totals: totalsOf(lines) };
}

/** The run's totals are simply the sum of its lines, which is what the property test proves. */
export function totalsOf(lines: readonly PayrollLine[]): PayrollRunTotals {
  const sum = (pick: (line: PayrollLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  return {
    totalBasicPesewas: sum((line) => line.basicPesewas),
    totalOvertimePesewas: sum((line) => line.overtimePesewas),
    totalTaxableAllowancePesewas: sum((line) => line.taxableAllowancePesewas),
    totalNonTaxableAllowancePesewas: sum((line) => line.nonTaxableAllowancePesewas),
    totalGrossPesewas: sum((line) => line.grossPesewas),
    totalSsnitEmployeePesewas: sum((line) => line.ssnitEmployeePesewas),
    totalPayePesewas: sum((line) => line.payePesewas),
    totalOtherDeductionsPesewas: sum((line) => line.otherDeductionsPesewas),
    totalNetPayPesewas: sum((line) => line.netPayPesewas),
    totalSsnitEmployerPesewas: sum((line) => line.ssnitEmployerPesewas),
  };
}

export function summaryOf(lines: readonly PayrollLine[], excluded: readonly PayrollRunExclusion[]) {
  return {
    lineCount: lines.length,
    employeeCount: new Set(lines.map((line) => line.employee.id)).size,
    adjustmentLineCount: lines.filter((line) => line.adjustsLineId !== null).length,
    excluded: [...excluded],
  };
}

const august = mockPeriods[1] as PayrollPeriod;
const september = mockPeriods[0] as PayrollPeriod;
const augustCalculation = calculateRun(AUGUST_RUN_ID, august, mockPayTerms, mockTaxTable);
const septemberCalculation = calculateRun(SEPTEMBER_RUN_ID, september, mockPayTerms, mockTaxTable);

/**
 * Two runs to start from: August is paid and has payslips, so a guard has
 * something to read; September is waiting for an administrator to approve it,
 * which the person who submitted it may never do.
 */
export const mockRuns: PayrollRun[] = [
  {
    id: SEPTEMBER_RUN_ID,
    periodId: SEPTEMBER_PERIOD_ID,
    periodStartDate: september.startDate,
    periodEndDate: september.endDate,
    status: 'PENDING_APPROVAL',
    taxTableId: TAX_TABLE_2026_ID,
    taxYear: 2026,
    totals: septemberCalculation.totals,
    summary: summaryOf(septemberCalculation.lines, septemberCalculation.excluded),
    calculatedAt: '2026-09-28T09:00:00Z',
    calculatedByUserId: HR_USER_ID,
    submittedAt: '2026-09-28T09:30:00Z',
    submittedByUserId: HR_USER_ID,
    submissionNote: 'Two guards picked up extra shifts at Ridge Towers this month.',
    approvedAt: null,
    approvedByUserId: null,
    approvalNote: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    paidAt: null,
    paidByUserId: null,
    paidOn: null,
    paymentReference: null,
    paymentNote: null,
    updatedAt: '2026-09-28T09:30:00Z',
  },
  {
    id: AUGUST_RUN_ID,
    periodId: AUGUST_PERIOD_ID,
    periodStartDate: august.startDate,
    periodEndDate: august.endDate,
    status: 'PAID',
    taxTableId: TAX_TABLE_2026_ID,
    taxYear: 2026,
    totals: augustCalculation.totals,
    summary: summaryOf(augustCalculation.lines, augustCalculation.excluded),
    calculatedAt: '2026-08-28T09:00:00Z',
    calculatedByUserId: HR_USER_ID,
    submittedAt: '2026-08-28T09:30:00Z',
    submittedByUserId: HR_USER_ID,
    submissionNote: null,
    approvedAt: '2026-08-28T14:00:00Z',
    approvedByUserId: ADMIN_USER_ID,
    approvalNote: 'Checked every overtime line against the exception queue.',
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    paidAt: '2026-08-29T10:00:00Z',
    paidByUserId: ADMIN_USER_ID,
    paidOn: '2026-08-28',
    paymentReference: 'GCB-TRF-2026-08-0031',
    paymentNote: null,
    updatedAt: '2026-08-29T10:00:00Z',
  },
];

export const mockLines: PayrollLine[] = [...septemberCalculation.lines, ...augustCalculation.lines];

/** A payslip exists only for a locked run, so only August has them. */
export const mockPayslips: Payslip[] = augustCalculation.lines.map((line, index) => ({
  id: `01927c3e-ffff-7000-8000-${String(index + 1).padStart(12, '0')}`,
  lineId: line.id,
  runId: AUGUST_RUN_ID,
  periodId: AUGUST_PERIOD_ID,
  periodStartDate: august.startDate,
  periodEndDate: august.endDate,
  employee: line.employee,
  runStatus: 'PAID',
  paidAt: '2026-08-29T10:00:00Z',
  basicMonthlyPesewas: line.basicMonthlyPesewas,
  daysInPeriod: line.daysInPeriod,
  daysEmployed: line.daysEmployed,
  basicPesewas: line.basicPesewas,
  scheduledMinutes: line.scheduledMinutes,
  regularMinutes: line.regularMinutes,
  overtimeMinutes: line.overtimeMinutes,
  punchedMinutes: line.punchedMinutes,
  overtimeHourlyPesewas: line.overtimeHourlyPesewas,
  overtimePesewas: line.overtimePesewas,
  taxableAllowancePesewas: line.taxableAllowancePesewas,
  nonTaxableAllowancePesewas: line.nonTaxableAllowancePesewas,
  grossPesewas: line.grossPesewas,
  taxableGrossPesewas: line.taxableGrossPesewas,
  ssnitEmployeeBasisPoints: mockTaxTable.ssnitEmployeeBasisPoints,
  ssnitEmployeePesewas: line.ssnitEmployeePesewas,
  ssnitEmployerBasisPoints: mockTaxTable.ssnitEmployerBasisPoints,
  ssnitEmployerPesewas: line.ssnitEmployerPesewas,
  chargeableIncomePesewas: line.chargeableIncomePesewas,
  payePesewas: line.payePesewas,
  otherDeductionsPesewas: line.otherDeductionsPesewas,
  netPayPesewas: line.netPayPesewas,
  taxTableId: TAX_TABLE_2026_ID,
  taxYear: 2026,
  adjustsLineId: null,
  adjustmentNote: null,
  pdfGeneratedAt: '2026-08-28T14:00:00Z',
  pdfSizeBytes: 21_480,
  // A fixed fictional digest; the mock never builds a real PDF.
  pdfSha256: `${'0'.repeat(56)}${String(index + 1).padStart(8, '0')}`.slice(0, 64),
}));
