import { describe, expect, it } from 'vitest';
import type { PayrollLine, PayrollRun, TaxTable } from '../../generated/prisma/client.js';
import {
  emptyRunSummary,
  exclusionsOf,
  toApiLine,
  toApiRun,
  toApiRunFromSummary,
  toStatutorySummary,
  totalsOf,
} from './run-mapping.js';

/**
 * Every figure a worker could dispute passes through this file, and ten of them
 * are sums that no other test compares to anything. So these tests add the
 * columns up by hand.
 */

const day = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const moment = (iso: string) => new Date(iso);
const COMPANY = 'company-1';
const USER = 'user-1';
const CHECKER = 'user-2';

/** A line that adds up, which each test then varies. */
const line = (over: Partial<PayrollLine> = {}): PayrollLine =>
  ({
    id: 'line-1',
    companyId: COMPANY,
    runId: 'run-1',
    employeeId: 'employee-1',
    staffNumber: 'SMT-00042',
    fullName: 'Kwame Mensah',
    employeeStatus: 'ACTIVE',
    adjustsLineId: null,
    adjustmentNote: null,
    payTermsId: 'terms-1',
    payTermsEffectiveFrom: day('2026-01-01'),
    basicMonthlyPesewas: 200_000,
    overtimeHourlyPesewas: 900,
    daysInPeriod: 30,
    daysEmployed: 30,
    scheduledMinutes: 14_400,
    punchedMinutes: 14_400,
    regularMinutes: 14_400,
    overtimeMinutes: 0,
    basicPesewas: 200_000,
    overtimePesewas: 0,
    taxableAllowancePesewas: 0,
    nonTaxableAllowancePesewas: 0,
    grossPesewas: 200_000,
    taxableGrossPesewas: 200_000,
    ssnitEmployeePesewas: 11_000,
    ssnitEmployerPesewas: 26_000,
    ssnitTier1Pesewas: 27_000,
    ssnitTier2Pesewas: 10_000,
    chargeableIncomePesewas: 189_000,
    payePesewas: 19_500,
    otherDeductionsPesewas: 0,
    netPayPesewas: 169_500,
    taxTableId: 'table-1',
    taxYear: 2026,
    createdAt: moment('2026-10-01T08:00:00.000Z'),
    updatedAt: moment('2026-10-01T08:00:00.000Z'),
    ...over,
  }) as PayrollLine;

const run = (over: Partial<PayrollRun> = {}): PayrollRun =>
  ({
    id: 'run-1',
    companyId: COMPANY,
    periodId: 'period-1',
    taxTableId: 'table-1',
    status: 'DRAFT',
    calculatedByUserId: USER,
    calculatedAt: moment('2026-10-01T08:00:00.000Z'),
    submittedByUserId: null,
    submittedAt: null,
    submissionNote: null,
    approvedByUserId: null,
    approvedAt: null,
    approvalNote: null,
    rejectedByUserId: null,
    rejectedAt: null,
    rejectionReason: null,
    paidByUserId: null,
    paidAt: null,
    paidOn: null,
    paymentReference: null,
    paymentNote: null,
    excludedEmployees: [],
    createdAt: moment('2026-10-01T08:00:00.000Z'),
    updatedAt: moment('2026-10-01T08:00:00.000Z'),
    ...over,
  }) as PayrollRun;

const PERIOD = { startsOn: day('2026-09-01'), endsOn: day('2026-09-30') };

const TABLE: TaxTable = {
  id: 'table-1',
  companyId: COMPANY,
  taxYear: 2026,
  effectiveFrom: day('2026-01-01'),
  effectiveTo: null,
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  sourceName: 'GRA PAYE rates 2026',
  sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
  sourceCheckedOn: day('2026-01-05'),
  createdAt: moment('2026-01-05T08:00:00.000Z'),
  createdByUserId: USER,
} as TaxTable;

describe('adding a run up', () => {
  it('sums all ten columns, not just the ones a screen happens to show', () => {
    const totals = totalsOf([
      line(),
      line({
        id: 'line-2',
        basicPesewas: 100_000,
        overtimePesewas: 3_600,
        taxableAllowancePesewas: 15_000,
        nonTaxableAllowancePesewas: 5_000,
        grossPesewas: 123_600,
        ssnitEmployeePesewas: 5_500,
        ssnitEmployerPesewas: 13_000,
        payePesewas: 4_050,
        otherDeductionsPesewas: 2_000,
        netPayPesewas: 112_050,
      }),
    ]);
    expect(totals).toEqual({
      totalBasicPesewas: 300_000,
      totalOvertimePesewas: 3_600,
      totalTaxableAllowancePesewas: 15_000,
      totalNonTaxableAllowancePesewas: 5_000,
      totalGrossPesewas: 323_600,
      totalSsnitEmployeePesewas: 16_500,
      totalPayePesewas: 23_550,
      totalOtherDeductionsPesewas: 2_000,
      totalNetPayPesewas: 281_550,
      totalSsnitEmployerPesewas: 39_000,
    });
  });

  it('is every column zero for a run with no lines', () => {
    expect(totalsOf([])).toEqual(emptyRunSummary().totals);
  });

  it('lets a total go negative, because a run of corrections takes money back', () => {
    // A total clamped at zero would hide money being recovered.
    const totals = totalsOf([line({ netPayPesewas: -15_275, basicPesewas: -75_000 })]);
    expect(totals.totalNetPayPesewas).toBe(-15_275);
    expect(totals.totalBasicPesewas).toBe(-75_000);
  });
});

describe('who was left out', () => {
  it('reads back the list the run froze', () => {
    const stored = [
      { employee: { id: 'e1', staffNumber: 'SMT-00001', fullName: 'One' }, reason: 'SUSPENDED' },
      { employee: { id: 'e2', staffNumber: 'SMT-00002', fullName: 'Two' }, reason: 'NO_PAY_TERMS' },
    ];
    expect(exclusionsOf(stored)).toEqual(stored);
  });

  it('is empty rather than broken for a shape nobody expected', () => {
    // The column can never be repaired, so a reader that threw would make the
    // whole run unreadable for ever.
    expect(exclusionsOf(null)).toEqual([]);
    expect(exclusionsOf({})).toEqual([]);
    expect(exclusionsOf('SUSPENDED')).toEqual([]);
    expect(exclusionsOf([1, 2, 3])).toEqual([]);
  });

  it('drops an entry missing anything a payroll officer needs to act on', () => {
    // A name with no staff number names somebody they cannot look up.
    expect(exclusionsOf([{ employee: { id: 'e1' }, reason: 'SUSPENDED' }])).toEqual([]);
    expect(
      exclusionsOf([{ employee: { id: 'e1', staffNumber: 'SMT-00001' }, reason: 'SUSPENDED' }]),
    ).toEqual([]);
    expect(
      exclusionsOf([
        { employee: { id: 'e1', staffNumber: 'SMT-00001', fullName: 'One' }, reason: 'BECAUSE' },
      ]),
    ).toEqual([]);
  });

  it('keeps the good entries and drops only the bad ones', () => {
    const good = {
      employee: { id: 'e1', staffNumber: 'SMT-00001', fullName: 'One' },
      reason: 'SUSPENDED',
    };
    expect(exclusionsOf([good, { employee: {}, reason: 'SUSPENDED' }])).toEqual([good]);
  });
});

describe('a run as the contract describes it', () => {
  it('sends the period dates as calendar dates and the moments as timestamps', () => {
    const mapped = toApiRun(run(), { period: PERIOD, taxYear: 2026, lines: [line()] });
    expect(mapped.periodStartDate).toBe('2026-09-01');
    expect(mapped.periodEndDate).toBe('2026-09-30');
    expect(mapped.calculatedAt).toBe('2026-10-01T08:00:00.000Z');
    expect(mapped.paidOn).toBeNull();
    expect(mapped.totals.totalNetPayPesewas).toBe(169_500);
    expect(mapped.summary).toEqual({
      lineCount: 1,
      employeeCount: 1,
      adjustmentLineCount: 0,
      excluded: [],
    });
  });

  it('counts one person once, however many lines they have', () => {
    const mapped = toApiRun(run(), {
      period: PERIOD,
      taxYear: 2026,
      lines: [
        line(),
        line({ id: 'line-2', adjustsLineId: 'line-1', adjustmentNote: 'Corrected.' }),
      ],
    });
    expect(mapped.summary.lineCount).toBe(2);
    expect(mapped.summary.employeeCount).toBe(1);
    expect(mapped.summary.adjustmentLineCount).toBe(1);
  });

  it('sends the payment day as a calendar date once it is paid', () => {
    const mapped = toApiRun(
      run({
        status: 'PAID',
        paidOn: day('2026-09-20'),
        paidAt: moment('2026-09-20T15:00:00.000Z'),
        paidByUserId: CHECKER,
      }),
      { period: PERIOD, taxYear: 2026, lines: [] },
    );
    expect(mapped.paidOn).toBe('2026-09-20');
    expect(mapped.paidAt).toBe('2026-09-20T15:00:00.000Z');
  });

  it('gives the same answer from totals somebody else added up', () => {
    // The list endpoint has the database do the sums. It must not produce a
    // different shape from the single-run endpoint, which counts the lines.
    const lines = [line(), line({ id: 'line-2', netPayPesewas: 112_050 })];
    const fromLines = toApiRun(run(), { period: PERIOD, taxYear: 2026, lines });
    const fromSummary = toApiRunFromSummary(run(), {
      period: PERIOD,
      taxYear: 2026,
      summary: {
        lineCount: 2,
        employeeCount: 1,
        adjustmentLineCount: 0,
        totals: totalsOf(lines),
      },
    });
    expect(fromSummary).toEqual(fromLines);
  });
});

describe('one line as the contract describes it', () => {
  it('names the worker, and the run an adjustment points back at', () => {
    const mapped = toApiLine({
      ...line({ adjustsLineId: 'older-line', adjustmentNote: 'Days employed corrected.' }),
      adjustsLine: { runId: 'older-run' },
    });
    expect(mapped.employee).toEqual({
      id: 'employee-1',
      staffNumber: 'SMT-00042',
      fullName: 'Kwame Mensah',
    });
    expect(mapped.adjustsLineId).toBe('older-line');
    expect(mapped.adjustsRunId).toBe('older-run');
    expect(mapped.payTermsEffectiveFrom).toBe('2026-01-01');
  });

  it('has no run to point at when it is an ordinary line', () => {
    const mapped = toApiLine({ ...line(), adjustsLine: null });
    expect(mapped.adjustsLineId).toBeNull();
    expect(mapped.adjustsRunId).toBeNull();
  });
});

describe('what the company owes the state', () => {
  it('prints the rates beside the amounts, and makes the two SSNIT figures tie', () => {
    const summary = toStatutorySummary(
      run({ status: 'LOCKED' }),
      PERIOD,
      TABLE,
      [line(), line({ id: 'line-2', employeeId: 'employee-2' })],
      moment('2026-10-05T09:00:00.000Z'),
    );
    expect(summary.employeeCount).toBe(2);
    expect(summary.ssnitEmployeeBasisPoints).toBe(550);
    expect(summary.totalSsnitEmployeePesewas).toBe(22_000);
    expect(summary.ssnitEmployerBasisPoints).toBe(1300);
    expect(summary.totalSsnitEmployerPesewas).toBe(52_000);
    // What is actually remitted is the two together.
    expect(summary.totalSsnitPesewas).toBe(74_000);
    // And the two tiers are a split of that same total (decision 26).
    expect(summary.totalSsnitTier1Pesewas + summary.totalSsnitTier2Pesewas).toBe(74_000);
    expect(summary.generatedAt).toBe('2026-10-05T09:00:00.000Z');
    expect(summary.taxYear).toBe(2026);
  });

  it('reports the rates of the run’s own version, not today’s', () => {
    // A summary of a run from two budgets ago must show the rates of its time.
    const old = { ...TABLE, id: 'table-2015', taxYear: 2015, ssnitEmployeeBasisPoints: 500 };
    const summary = toStatutorySummary(run(), PERIOD, old as TaxTable, [line()], new Date(0));
    expect(summary.taxYear).toBe(2015);
    expect(summary.ssnitEmployeeBasisPoints).toBe(500);
    expect(summary.taxTableId).toBe('table-2015');
  });
});
