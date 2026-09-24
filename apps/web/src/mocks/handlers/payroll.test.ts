import type { EmployeePayTerms } from '@samtec/contracts';
import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { mockEmployees } from '../data/employees';
import {
  AUGUST_PERIOD_ID,
  calculatePay,
  daysEmployedIn,
  mockTaxTable,
  SEPTEMBER_PERIOD_ID,
} from '../data/payroll';

/** Kwame Kofi Mensah, SMT-00001, who signs in as guard@samtec.example. */
const GUARD_EMPLOYEE_ID = '01927c3e-5a4b-7c8d-9e0f-000000000001';
/** Akua Asante, SMT-00004: another guard, whose payslips this guard may never read. */
const OTHER_EMPLOYEE_ID = '01927c3e-5a4b-7c8d-9e0f-000000000004';

function termsWith(overrides: Partial<EmployeePayTerms>): EmployeePayTerms {
  return {
    id: '01927c3e-dddd-7000-8000-000000000999',
    employeeId: GUARD_EMPLOYEE_ID,
    effectiveFrom: '2026-01-01',
    basicMonthlyPesewas: 0,
    overtimeHourlyPesewas: 0,
    taxableAllowancePesewas: 0,
    nonTaxableAllowancePesewas: 0,
    otherDeductionPesewas: 0,
    createdAt: '2026-01-05T10:00:00Z',
    createdByUserId: '01927c3e-2222-7ccc-9ddd-000000000002',
    ...overrides,
  };
}

const FULL_MONTH = { daysInPeriod: 30, daysEmployed: 30, regularMinutes: 0, overtimeMinutes: 0 };

/**
 * Seven of the eight hand-calculated payslips from
 * docs/plan/09-payroll-engine-ghana.md, every figure worked out by hand and
 * checked a second way. The API's own engine is pinned to these same numbers,
 * so the mock and the real thing can never quietly drift apart.
 *
 * The eighth, the night shift that crosses the period boundary, cannot be
 * pinned here: it is a rule about which date a segment belongs to (decision 5),
 * and this function takes minutes, not dated segments. It is pinned against the
 * API's engine, which reads the segments themselves.
 */
describe('the payroll calculation, to the pesewa', () => {
  it('taxes nothing below the threshold', () => {
    const pay = calculatePay(termsWith({ basicMonthlyPesewas: 45_000 }), FULL_MONTH, mockTaxTable);
    expect(pay.basicPesewas).toBe(45_000);
    expect(pay.ssnitEmployeePesewas).toBe(2_475);
    expect(pay.chargeableIncomePesewas).toBe(42_525);
    expect(pay.payePesewas).toBe(0);
    expect(pay.netPayPesewas).toBe(42_525);
  });

  it('works out a mid-band salary', () => {
    const pay = calculatePay(termsWith({ basicMonthlyPesewas: 200_000 }), FULL_MONTH, mockTaxTable);
    expect(pay.ssnitEmployeePesewas).toBe(11_000);
    expect(pay.chargeableIncomePesewas).toBe(189_000);
    expect(pay.payePesewas).toBe(19_500);
    expect(pay.netPayPesewas).toBe(169_500);
  });

  it('pays forty hours of overtime on top of the basic', () => {
    const pay = calculatePay(
      termsWith({ basicMonthlyPesewas: 120_000, overtimeHourlyPesewas: 800 }),
      { ...FULL_MONTH, regularMinutes: 12_480, overtimeMinutes: 2_400 },
      mockTaxTable,
    );
    expect(pay.overtimePesewas).toBe(32_000);
    expect(pay.grossPesewas).toBe(152_000);
    expect(pay.ssnitEmployeePesewas).toBe(6_600);
    expect(pay.payePesewas).toBe(11_870);
    expect(pay.netPayPesewas).toBe(133_530);
  });

  it('pro-rates the basic for somebody who joined mid-month, rounding half-up', () => {
    const pay = calculatePay(
      termsWith({ basicMonthlyPesewas: 150_000 }),
      { ...FULL_MONTH, daysEmployed: 15 },
      mockTaxTable,
    );
    expect(pay.basicPesewas).toBe(75_000);
    expect(pay.ssnitEmployeePesewas).toBe(4_125);
    expect(pay.chargeableIncomePesewas).toBe(70_875);
    // PAYE lands on exactly 1687.5 pesewas, and half-up takes it to 1688.
    expect(pay.payePesewas).toBe(1_688);
    expect(pay.netPayPesewas).toBe(69_187);
  });

  it('pro-rates the basic for somebody who left mid-month', () => {
    const pay = calculatePay(
      termsWith({ basicMonthlyPesewas: 180_000 }),
      { ...FULL_MONTH, daysEmployed: 10 },
      mockTaxTable,
    );
    expect(pay.basicPesewas).toBe(60_000);
    expect(pay.ssnitEmployeePesewas).toBe(3_300);
    expect(pay.payePesewas).toBe(385);
    expect(pay.netPayPesewas).toBe(56_315);
  });

  it('pays a night-shift worker their full month', () => {
    const pay = calculatePay(termsWith({ basicMonthlyPesewas: 100_000 }), FULL_MONTH, mockTaxTable);
    expect(pay.ssnitEmployeePesewas).toBe(5_500);
    expect(pay.chargeableIncomePesewas).toBe(94_500);
    expect(pay.payePesewas).toBe(4_050);
    expect(pay.netPayPesewas).toBe(90_450);
  });

  it('leaves the non-taxable allowance out of the taxed income', () => {
    const pay = calculatePay(
      termsWith({
        basicMonthlyPesewas: 160_000,
        taxableAllowancePesewas: 25_000,
        nonTaxableAllowancePesewas: 15_000,
        otherDeductionPesewas: 5_000,
      }),
      FULL_MONTH,
      mockTaxTable,
    );
    expect(pay.grossPesewas).toBe(200_000);
    // Taxed on 160,000 + 25,000, never on the 15,000 that is not taxed.
    expect(pay.taxableGrossPesewas).toBe(185_000);
    expect(pay.ssnitEmployeePesewas).toBe(8_800);
    expect(pay.chargeableIncomePesewas).toBe(176_200);
    expect(pay.payePesewas).toBe(17_260);
    expect(pay.netPayPesewas).toBe(168_940);
  });

  it('reaches the top band above twenty thousand cedis', () => {
    const pay = calculatePay(
      termsWith({ basicMonthlyPesewas: 2_500_000, taxableAllowancePesewas: 300_000 }),
      FULL_MONTH,
      mockTaxTable,
    );
    expect(pay.grossPesewas).toBe(2_800_000);
    expect(pay.ssnitEmployeePesewas).toBe(137_500);
    expect(pay.chargeableIncomePesewas).toBe(2_662_500);
    expect(pay.payePesewas).toBe(769_675);
    expect(pay.netPayPesewas).toBe(1_892_825);
  });

  it('keeps the employer contributions out of the worker deductions', () => {
    const pay = calculatePay(termsWith({ basicMonthlyPesewas: 200_000 }), FULL_MONTH, mockTaxTable);
    expect(pay.ssnitEmployerPesewas).toBe(26_000);
    expect(pay.ssnitTier1Pesewas).toBe(27_000);
    expect(pay.ssnitTier2Pesewas).toBe(10_000);
    // The net pay never touches any of the three.
    expect(pay.netPayPesewas).toBe(
      pay.grossPesewas - pay.ssnitEmployeePesewas - pay.payePesewas - pay.otherDeductionsPesewas,
    );
  });
});

describe('mock payroll API: who may see what', () => {
  it('shows an administrator the months, and refuses a supervisor entirely', async () => {
    await signInForTests('admin@samtec.example');
    const asAdmin = await fetchClient.GET('/payroll/periods');
    expect(asAdmin.data?.items.map((period) => period.month)).toEqual([9, 8]);

    await signInForTests('supervisor@samtec.example');
    const asSupervisor = await fetchClient.GET('/payroll/periods');
    expect(asSupervisor.response.status).toBe(403);
  });

  it('gives a guard only their own payslips', async () => {
    await signInForTests('guard@samtec.example');
    const mine = await fetchClient.GET('/payroll/payslips');
    expect(mine.data?.items.length).toBeGreaterThan(0);
    expect(mine.data?.items.every((slip) => slip.employee.id === GUARD_EMPLOYEE_ID)).toBe(true);

    const theirs = await fetchClient.GET('/payroll/payslips', {
      params: { query: { employeeId: OTHER_EMPLOYEE_ID } },
    });
    expect(theirs.response.status).toBe(404);
  });

  it("answers 404, never 403, for another guard's payslip", async () => {
    await signInForTests('admin@samtec.example');
    const all = await fetchClient.GET('/payroll/payslips', {
      params: { query: { employeeId: OTHER_EMPLOYEE_ID } },
    });
    const otherPayslipId = all.data?.items[0]?.id ?? '';
    expect(otherPayslipId).not.toBe('');

    await signInForTests('guard@samtec.example');
    const refused = await fetchClient.GET('/payroll/payslips/{payslipId}', {
      params: { path: { payslipId: otherPayslipId } },
    });
    expect(refused.response.status).toBe(404);
    expect(refused.error?.detail).toBe('No payslip exists with this ID.');
  });

  it('never lets a run, a line or a payslip carry bank details', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const runId = runs.data?.items[0]?.id ?? '';
    const lines = await fetchClient.GET('/payroll/runs/{runId}/lines', {
      params: { path: { runId } },
    });
    const payslips = await fetchClient.GET('/payroll/payslips');
    const everything = JSON.stringify([runs.data, lines.data, payslips.data]);
    expect(everything).not.toMatch(/accountNumber|momoNumber|bankName/);
  });
});

describe('mock payroll API: the maker is never the checker', () => {
  it('lets the maker submit, and refuses anybody else', async () => {
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    // September already has a run waiting for approval, not an approved one,
    // so another draft is allowed.
    const runId = draft.data?.id ?? '';
    expect(draft.response.status).toBe(201);
    expect(draft.data?.status).toBe('DRAFT');

    // An administrator who did not calculate it may not submit it.
    await signInForTests('admin@samtec.example');
    const wrongPerson = await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });
    expect(wrongPerson.response.status).toBe(403);

    await signInForTests('hr@samtec.example');
    const submitted = await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: { note: 'Ready for checking.' },
    });
    expect(submitted.data?.status).toBe('PENDING_APPROVAL');
    expect(submitted.data?.submissionNote).toBe('Ready for checking.');
  });

  it('refuses the submitter approving their own run, and lets a second person do it', async () => {
    await signInForTests('admin@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    const runId = draft.data?.id ?? '';
    await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });

    // The same administrator prepared and submitted it, so they may not approve.
    const ownRun = await fetchClient.POST('/payroll/runs/{runId}/approve', {
      params: { path: { runId } },
      body: {},
    });
    expect(ownRun.response.status).toBe(403);

    // HR may never approve at all, whoever submitted it.
    await signInForTests('hr@samtec.example');
    const wrongRole = await fetchClient.POST('/payroll/runs/{runId}/approve', {
      params: { path: { runId } },
      body: {},
    });
    expect(wrongRole.response.status).toBe(403);

    // A different administrator can, which is the whole point of the rule.
    await signInForTests('admin2@samtec.example');
    const secondPerson = await fetchClient.POST('/payroll/runs/{runId}/approve', {
      params: { path: { runId } },
      body: { note: 'Checked the overtime lines.' },
    });
    expect(secondPerson.data?.status).toBe('LOCKED');
    expect(secondPerson.data?.approvedByUserId).not.toBe(secondPerson.data?.calculatedByUserId);
  });

  it('locks a run on approval, makes its payslips, and then marks it paid', async () => {
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    const runId = draft.data?.id ?? '';
    await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });

    await signInForTests('admin@samtec.example');
    const approved = await fetchClient.POST('/payroll/runs/{runId}/approve', {
      params: { path: { runId } },
      body: { note: 'Checked against the exception queue.' },
    });
    expect(approved.data?.status).toBe('LOCKED');
    expect(approved.data?.approvedByUserId).not.toBe(approved.data?.submittedByUserId);

    const payslips = await fetchClient.GET('/payroll/payslips', {
      params: { query: { runId } },
    });
    expect(payslips.data?.items.length).toBe(approved.data?.summary.lineCount);

    const paid = await fetchClient.POST('/payroll/runs/{runId}/mark-paid', {
      params: { path: { runId } },
      // A day that has already been, because the API refuses a future payment day.
      body: { paidOn: '2026-09-20', paymentReference: 'GCB-TRF-2026-09-0042' },
    });
    expect(paid.data?.status).toBe('PAID');
    expect(paid.data?.paidOn).toBe('2026-09-20');
  });
});

describe('mock payroll API: the rules of a run', () => {
  it('adds up its totals from its own lines, exactly', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const run = runs.data?.items.find((candidate) => candidate.status === 'PENDING_APPROVAL');
    const lines = await fetchClient.GET('/payroll/runs/{runId}/lines', {
      params: { path: { runId: run?.id ?? '' }, query: { limit: 100 } },
    });
    const sum = (pick: (line: { netPayPesewas: number; grossPesewas: number }) => number) =>
      (lines.data?.items ?? []).reduce((total, line) => total + pick(line), 0);
    expect(run?.totals.totalNetPayPesewas).toBe(sum((line) => line.netPayPesewas));
    expect(run?.totals.totalGrossPesewas).toBe(sum((line) => line.grossPesewas));
    // Every line holds the identity the database CHECK enforces.
    for (const line of lines.data?.items ?? []) {
      expect(line.netPayPesewas).toBe(
        line.grossPesewas -
          line.ssnitEmployeePesewas -
          line.payePesewas -
          line.otherDeductionsPesewas,
      );
    }
  });

  it('names everybody it left off, and why', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const run = runs.data?.items.find((candidate) => candidate.status === 'PENDING_APPROVAL');
    const reasons = (run?.summary.excluded ?? []).map((row) => row.reason);
    // Grace Adjei is suspended; Selorm Agbeko has no pay terms yet.
    expect(reasons).toContain('SUSPENDED');
    expect(reasons).toContain('NO_PAY_TERMS');
    const suspended = mockEmployees.find((employee) => employee.status === 'SUSPENDED');
    expect(run?.summary.excluded.some((row) => row.employee.id === suspended?.id)).toBe(true);
  });

  it('offers a bank file only once the run is approved', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const waiting = runs.data?.items.find((run) => run.status === 'PENDING_APPROVAL');
    const paid = runs.data?.items.find((run) => run.status === 'PAID');

    const tooEarly = await fetchClient.GET('/payroll/runs/{runId}/bank-export', {
      params: { path: { runId: waiting?.id ?? '' } },
    });
    expect(tooEarly.response.status).toBe(409);

    const file = await fetchClient.GET('/payroll/runs/{runId}/bank-export', {
      params: { path: { runId: paid?.id ?? '' } },
      parseAs: 'text',
    });
    expect(file.response.headers.get('Content-Type')).toBe('text/csv');
    expect(file.response.headers.get('Cache-Control')).toBe('no-store');
    const csv = String(file.data);
    expect(csv.split('\n')[0]).toBe(
      '"staff_number","full_name","bank_name","account_name","account_number","momo_number","net_pay_pesewas","net_pay_ghs","employee_reference","details_changed_after_approval"',
    );
    // The bank file is the one place account numbers appear.
    expect(csv).toMatch(/SMT-00001/);
  });

  it('cannot be forged by a name holding a comma, a quote or a line break', async () => {
    await signInForTests('hr@samtec.example');
    // A dishonest payroll officer tries to break the row apart and add a payee.
    await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: 'Akwaaba Bank',
        accountName: 'Kwame "Ghost", 9999999999999, 500000',
        accountNumber: '1234567890123',
        momoNumber: null,
      },
    });
    const runs = await fetchClient.GET('/payroll/runs');
    const paid = runs.data?.items.find((run) => run.status === 'PAID');
    const file = await fetchClient.GET('/payroll/runs/{runId}/bank-export', {
      params: { path: { runId: paid?.id ?? '' } },
      parseAs: 'text',
    });
    const rows = String(file.data).split('\n');
    // Every row still has exactly ten cells, so nothing was smuggled in.
    for (const row of rows) {
      expect(row.match(/","/g)?.length).toBe(9);
    }
    // The quote inside the name is doubled, as RFC 4180 says.
    expect(String(file.data)).toContain('""Ghost""');
  });

  it('writes a spreadsheet formula as text, never as a formula', async () => {
    await signInForTests('hr@samtec.example');
    // The contract refuses a leading formula character outright.
    const refused = await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: '=HYPERLINK("http://example.invalid")',
        accountName: 'Kwame Mensah',
        accountNumber: '1234567890123',
        momoNumber: null,
      },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.error?.errors?.[0]?.path).toBe('bankName');
  });

  it('refuses a formula hiding behind a leading space', async () => {
    await signInForTests('hr@samtec.example');
    // A spreadsheet trims the space away on import, then runs what follows it.
    const refused = await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: 'Akwaaba Bank',
        accountName: ' =1+1+cmd|calc',
        accountNumber: '1234567890123',
        momoNumber: null,
      },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.error?.errors?.[0]?.path).toBe('accountName');
  });

  it('says in the file when a destination moved after the run was approved', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const paid = runs.data?.items.find((run) => run.status === 'PAID');

    const before = await fetchClient.GET('/payroll/runs/{runId}/bank-export', {
      params: { path: { runId: paid?.id ?? '' } },
      parseAs: 'text',
    });
    expect(String(before.data)).not.toContain('"yes"');

    // The approval covered what each worker is owed, not where it is sent.
    await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: 'Akwaaba Bank',
        accountName: 'Somebody Else',
        accountNumber: '9999999999999',
        momoNumber: null,
      },
    });
    const after = await fetchClient.GET('/payroll/runs/{runId}/bank-export', {
      params: { path: { runId: paid?.id ?? '' } },
      parseAs: 'text',
    });
    const changed = String(after.data)
      .split('\n')
      .find((row) => row.includes('SMT-00001'));
    expect(changed?.endsWith('"yes"')).toBe(true);
  });

  it('reports what the run owes SSNIT and the GRA, with the rates beside the amounts', async () => {
    await signInForTests('hr@samtec.example');
    const runs = await fetchClient.GET('/payroll/runs');
    const paid = runs.data?.items.find((run) => run.status === 'PAID');
    const summary = await fetchClient.GET('/payroll/runs/{runId}/statutory-summary', {
      params: { path: { runId: paid?.id ?? '' } },
    });
    expect(summary.data?.ssnitEmployeeBasisPoints).toBe(550);
    expect(summary.data?.ssnitEmployerBasisPoints).toBe(1300);
    expect(summary.data?.totalSsnitPesewas).toBe(
      (summary.data?.totalSsnitEmployeePesewas ?? 0) +
        (summary.data?.totalSsnitEmployerPesewas ?? 0),
    );
  });
});

describe('mock payroll API: periods, pay terms and payment details', () => {
  it('opens a whole month from a year and a month, and refuses a second one', async () => {
    await signInForTests('hr@samtec.example');
    const opened = await fetchClient.POST('/payroll/periods', { body: { year: 2026, month: 10 } });
    expect(opened.data?.startDate).toBe('2026-10-01');
    expect(opened.data?.endDate).toBe('2026-10-31');
    expect(opened.data?.status).toBe('OPEN');

    const again = await fetchClient.POST('/payroll/periods', { body: { year: 2026, month: 10 } });
    expect(again.response.status).toBe(409);
  });

  it('closes a month once and never reopens it', async () => {
    await signInForTests('hr@samtec.example');
    const closed = await fetchClient.POST('/payroll/periods/{periodId}/close', {
      params: { path: { periodId: SEPTEMBER_PERIOD_ID } },
    });
    expect(closed.data?.status).toBe('CLOSED');
    expect(closed.data?.closedByUserId).not.toBeNull();

    const twice = await fetchClient.POST('/payroll/periods/{periodId}/close', {
      params: { path: { periodId: SEPTEMBER_PERIOD_ID } },
    });
    expect(twice.response.status).toBe(409);
  });

  it('adds a new pay terms row instead of changing the one before it', async () => {
    await signInForTests('hr@samtec.example');
    const before = await fetchClient.GET('/employees/{employeeId}/pay-terms', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
    });
    const first = before.data?.items[0];
    expect(first).toBeDefined();

    const added = await fetchClient.PUT('/employees/{employeeId}/pay-terms', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        effectiveFrom: '2026-10-01',
        basicMonthlyPesewas: 130_000,
        overtimeHourlyPesewas: 950,
        taxableAllowancePesewas: 0,
        nonTaxableAllowancePesewas: 0,
        otherDeductionPesewas: 0,
      },
    });
    expect(added.response.status).toBe(201);

    const after = await fetchClient.GET('/employees/{employeeId}/pay-terms', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
    });
    expect(after.data?.items.length).toBe((before.data?.items.length ?? 0) + 1);
    // The older row is untouched, so an old payslip can still be explained.
    const stillThere = after.data?.items.find((row) => row.id === first?.id);
    expect(stillThere).toEqual(first);
  });

  it('gives the run for a month the pay terms in force on its last day', async () => {
    await signInForTests('hr@samtec.example');
    const one = await fetchClient.GET('/employees/{employeeId}/pay-terms', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID }, query: { effectiveOn: '2026-09-30' } },
    });
    expect(one.data?.items.length).toBe(1);
    const effectiveFrom = one.data?.items[0]?.effectiveFrom ?? '';
    expect(effectiveFrom).not.toBe('');
    expect(effectiveFrom <= '2026-09-30').toBe(true);
  });

  it('replaces payment details in place and never caches the answer', async () => {
    await signInForTests('hr@samtec.example');
    const saved = await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: null,
        accountName: null,
        accountNumber: null,
        momoNumber: '+233241234567',
      },
    });
    expect(saved.response.status).toBe(200);
    expect(saved.data?.momoNumber).toBe('+233241234567');
    expect(saved.data?.bankName).toBeNull();
    expect(saved.response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('names a rejected field without ever quoting what was typed', async () => {
    await signInForTests('hr@samtec.example');
    const refused = await fetchClient.PUT('/employees/{employeeId}/payment-details', {
      params: { path: { employeeId: GUARD_EMPLOYEE_ID } },
      body: {
        bankName: 'Akwaaba Bank',
        accountName: 'Kwame Mensah',
        accountNumber: 'not-an-account',
        momoNumber: null,
      },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.error?.errors?.[0]?.path).toBe('accountNumber');
    expect(JSON.stringify(refused.error)).not.toMatch(/not-an-account/);
  });

  it('keeps the tax tables for administrators only', async () => {
    await signInForTests('admin@samtec.example');
    const tables = await fetchClient.GET('/payroll/tax-tables');
    expect(tables.data?.items[0]?.taxYear).toBe(2026);
    expect(tables.data?.items[0]?.bands.length).toBe(7);

    await signInForTests('hr@samtec.example');
    const refused = await fetchClient.GET('/payroll/tax-tables');
    expect(refused.response.status).toBe(403);
  });
});

/** A fixed pseudo-random sequence, so a failure can always be reproduced. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('the payroll calculation: the rules that must hold for every line', () => {
  it('always adds up, so a worker can check their own payslip by hand', () => {
    const next = sequence(20_260_924);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const daysInPeriod = 28 + Math.floor(next() * 4);
      const pay = calculatePay(
        termsWith({
          basicMonthlyPesewas: Math.floor(next() * 500_000) + 1,
          overtimeHourlyPesewas: Math.floor(next() * 2_000),
          taxableAllowancePesewas: Math.floor(next() * 40_000),
          nonTaxableAllowancePesewas: Math.floor(next() * 20_000),
          otherDeductionPesewas: Math.floor(next() * 10_000),
        }),
        {
          daysInPeriod,
          daysEmployed: 1 + Math.floor(next() * daysInPeriod),
          regularMinutes: Math.floor(next() * 15_000),
          overtimeMinutes: Math.floor(next() * 3_000),
        },
        mockTaxTable,
      );

      // Every total is exactly the sum of the parts printed beside it.
      expect(pay.grossPesewas).toBe(
        pay.basicPesewas +
          pay.overtimePesewas +
          pay.taxableAllowancePesewas +
          pay.nonTaxableAllowancePesewas,
      );
      expect(pay.taxableGrossPesewas).toBe(
        pay.basicPesewas + pay.overtimePesewas + pay.taxableAllowancePesewas,
      );
      expect(pay.chargeableIncomePesewas).toBe(
        Math.max(0, pay.taxableGrossPesewas - pay.ssnitEmployeePesewas),
      );
      // The identity the database CHECK enforces on every line.
      expect(pay.netPayPesewas).toBe(
        pay.grossPesewas - pay.ssnitEmployeePesewas - pay.payePesewas - pay.otherDeductionsPesewas,
      );
      // Tax never exceeds the income it is charged on.
      expect(pay.payePesewas).toBeLessThanOrEqual(pay.chargeableIncomePesewas);
      expect(Number.isInteger(pay.netPayPesewas)).toBe(true);
    }
  });

  it('counts the days a worker was employed inside the period, both ends included', () => {
    const wholeMonth = { hireDate: '2024-01-15', terminationDate: null };
    expect(daysEmployedIn(wholeMonth, '2026-09-01', '2026-09-30')).toBe(30);
    // Hired on the 16th: the 16th itself counts.
    expect(
      daysEmployedIn({ hireDate: '2026-09-16', terminationDate: null }, '2026-09-01', '2026-09-30'),
    ).toBe(15);
    // Left on the 10th: the last day of employment counts.
    expect(
      daysEmployedIn(
        { hireDate: '2023-05-02', terminationDate: '2026-09-10' },
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBe(10);
    // One single day, and none at all.
    expect(
      daysEmployedIn(
        { hireDate: '2026-09-30', terminationDate: '2026-09-30' },
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBe(1);
    expect(
      daysEmployedIn({ hireDate: '2026-10-01', terminationDate: null }, '2026-09-01', '2026-09-30'),
    ).toBe(0);
    expect(
      daysEmployedIn(
        { hireDate: '2023-01-01', terminationDate: '2026-07-31' },
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBe(0);
  });

  it('refuses a period of no days rather than dividing by zero', () => {
    expect(() =>
      calculatePay(
        termsWith({ basicMonthlyPesewas: 100_000 }),
        { daysInPeriod: 0, daysEmployed: 0, regularMinutes: 0, overtimeMinutes: 0 },
        mockTaxTable,
      ),
    ).toThrow();
  });
});

describe('mock payroll API: a run that is sent back', () => {
  async function submittedRun(): Promise<string> {
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    const runId = draft.data?.id ?? '';
    await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });
    return runId;
  }

  it('needs a reason, and records who rejected it', async () => {
    const runId = await submittedRun();
    await signInForTests('admin@samtec.example');

    const noReason = await fetchClient.POST('/payroll/runs/{runId}/reject', {
      params: { path: { runId } },
      body: {} as { reason: string },
    });
    expect(noReason.response.status).toBe(400);
    expect(noReason.error?.errors?.[0]?.path).toBe('reason');

    const rejected = await fetchClient.POST('/payroll/runs/{runId}/reject', {
      params: { path: { runId } },
      body: { reason: 'SMT-00001 is on the old overtime rate. Fix it and calculate again.' },
    });
    expect(rejected.data?.status).toBe('REJECTED');
    expect(rejected.data?.rejectedByUserId).not.toBeNull();
    expect(rejected.data?.rejectionReason).toMatch(/old overtime rate/);
  });

  it('is the end of that run: it can never be approved or submitted afterwards', async () => {
    const runId = await submittedRun();
    await signInForTests('admin@samtec.example');
    await fetchClient.POST('/payroll/runs/{runId}/reject', {
      params: { path: { runId } },
      body: { reason: 'The overtime looks wrong; please check the exception queue.' },
    });

    const approved = await fetchClient.POST('/payroll/runs/{runId}/approve', {
      params: { path: { runId } },
      body: {},
    });
    expect(approved.response.status).toBe(409);

    await signInForTests('hr@samtec.example');
    const resubmitted = await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });
    expect(resubmitted.response.status).toBe(409);
  });

  it('refuses the person who submitted it, even to reject', async () => {
    await signInForTests('admin@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    const runId = draft.data?.id ?? '';
    await fetchClient.POST('/payroll/runs/{runId}/submit', {
      params: { path: { runId } },
      body: {},
    });
    const ownRun = await fetchClient.POST('/payroll/runs/{runId}/reject', {
      params: { path: { runId } },
      body: { reason: 'Trying to send back my own run.' },
    });
    expect(ownRun.response.status).toBe(403);
  });
});

describe('mock payroll API: one approved run a month, and one payslip a line', () => {
  it('refuses a second approved run for the same period', async () => {
    // August already has a PAID run, so a new one for that month is refused.
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: AUGUST_PERIOD_ID },
    });
    expect(draft.response.status).toBe(409);
  });

  it('serves a payslip PDF with the right type, file name and scoping', async () => {
    await signInForTests('guard@samtec.example');
    const mine = await fetchClient.GET('/payroll/payslips');
    const payslipId = mine.data?.items[0]?.id ?? '';
    const staffNumber = mine.data?.items[0]?.employee.staffNumber ?? '';
    expect(payslipId).not.toBe('');

    const pdf = await fetchClient.GET('/payroll/payslips/{payslipId}/pdf', {
      params: { path: { payslipId } },
      parseAs: 'arrayBuffer',
    });
    expect(pdf.response.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.response.headers.get('Cache-Control')).toBe('no-store');
    expect(pdf.response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="payslip-${staffNumber}-2026-08.pdf"`,
    );
    // It really is a PDF, not an empty body with a hopeful header.
    const bytes = new Uint8Array(pdf.data as ArrayBuffer);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(300);
  });

  it("refuses a guard another guard's PDF, the same way it hides the payslip", async () => {
    await signInForTests('admin@samtec.example');
    const all = await fetchClient.GET('/payroll/payslips', {
      params: { query: { employeeId: OTHER_EMPLOYEE_ID } },
    });
    const otherId = all.data?.items[0]?.id ?? '';

    await signInForTests('guard@samtec.example');
    const refused = await fetchClient.GET('/payroll/payslips/{payslipId}/pdf', {
      params: { path: { payslipId: otherId } },
    });
    expect(refused.response.status).toBe(404);
  });
});

describe('mock payroll API: adding a version of the statutory rates', () => {
  const bands2027 = [
    { ordinal: 1, widthPesewas: 50_000, rateBasisPoints: 0 },
    { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
    { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 },
  ];
  const table2027 = {
    taxYear: 2027,
    effectiveFrom: '2027-01-01',
    ssnitEmployeeBasisPoints: 550,
    ssnitEmployerBasisPoints: 1300,
    ssnitTier1BasisPoints: 1350,
    ssnitTier2BasisPoints: 500,
    bands: bands2027,
    sourceName: 'GRA PAYE rates 2027',
    sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
    sourceCheckedOn: '2026-09-20',
  };

  it('stores a new version rather than changing the old one', async () => {
    await signInForTests('admin@samtec.example');
    const added = await fetchClient.POST('/payroll/tax-tables', { body: table2027 });
    expect(added.response.status).toBe(201);
    expect(added.data?.taxYear).toBe(2027);

    const all = await fetchClient.GET('/payroll/tax-tables');
    expect(all.data?.items.length).toBe(2);
    // The 2026 row is untouched, so an old run can still be reproduced.
    expect(all.data?.items.some((table) => table.taxYear === 2026)).toBe(true);
  });

  it('refuses a table whose rates nobody could trace', async () => {
    await signInForTests('admin@samtec.example');
    const { sourceName, ...noSource } = table2027;
    const refused = await fetchClient.POST('/payroll/tax-tables', {
      body: noSource as typeof table2027,
    });
    expect(refused.response.status).toBe(400);
    expect(refused.error?.errors?.[0]?.path).toBe('sourceName');
  });

  it('refuses a table with no open top band, which would leave high earners untaxed', async () => {
    await signInForTests('admin@samtec.example');
    const closedTop = {
      ...table2027,
      bands: [
        { ordinal: 1, widthPesewas: 50_000, rateBasisPoints: 0 },
        { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 3500 },
      ],
    };
    const refused = await fetchClient.POST('/payroll/tax-tables', { body: closedTop });
    expect(refused.response.status).toBe(400);
    // The API joins a validation path with dots, so the mock does too.
    expect(refused.error?.errors?.[0]?.path).toBe('bands.1.widthPesewas');
  });

  it('refuses a second version starting on the same day', async () => {
    await signInForTests('admin@samtec.example');
    await fetchClient.POST('/payroll/tax-tables', { body: table2027 });
    const again = await fetchClient.POST('/payroll/tax-tables', { body: table2027 });
    expect(again.response.status).toBe(409);
  });

  it('gives a period the version in force on its last day', async () => {
    await signInForTests('admin@samtec.example');
    // A mid-year budget: a second version starting inside September.
    await fetchClient.POST('/payroll/tax-tables', {
      body: { ...table2027, taxYear: 2026, effectiveFrom: '2026-09-15' },
    });
    const onSeptemberEnd = await fetchClient.GET('/payroll/tax-tables', {
      params: { query: { effectiveOn: '2026-09-30' } },
    });
    expect(onSeptemberEnd.data?.items.length).toBe(1);
    expect(onSeptemberEnd.data?.items[0]?.effectiveFrom).toBe('2026-09-15');

    // A run for September then uses that newer version, not the January one.
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    expect(draft.data?.taxTableId).toBe(onSeptemberEnd.data?.items[0]?.id);
  });
});

describe('mock payroll API: a run totals exactly what its lines say', () => {
  it('sums every one of the ten totals from the lines themselves', async () => {
    await signInForTests('hr@samtec.example');
    const draft = await fetchClient.POST('/payroll/runs', {
      body: { periodId: SEPTEMBER_PERIOD_ID },
    });
    const runId = draft.data?.id ?? '';
    const lines = await fetchClient.GET('/payroll/runs/{runId}/lines', {
      params: { path: { runId }, query: { limit: 100 } },
    });
    const items = lines.data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    const sum = (pick: (line: (typeof items)[number]) => number) =>
      items.reduce((total, line) => total + pick(line), 0);

    expect(draft.data?.totals).toEqual({
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
    });
    expect(draft.data?.summary.lineCount).toBe(items.length);
  });
});
