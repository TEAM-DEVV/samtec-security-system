import type {
  CreatePayrollPeriodRequest,
  CreatePayrollRunRequest,
  CreateTaxTableRequest,
  CurrentUser,
  EmployeePaymentDetails,
  EmployeePayTerms,
  EmployeePayTermsList,
  PayrollLine,
  PayrollLineList,
  PayrollPeriod,
  PayrollPeriodList,
  PayrollRun,
  PayrollRunList,
  PayrollStatutorySummary,
  Payslip,
  PayslipList,
  TaxTable,
  TaxTableList,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { mockEmployees } from '../data/employees';
import {
  calculateRun,
  daysBetweenInclusive,
  mockLines,
  mockPaymentDetails,
  mockPayslips,
  mockPayTerms,
  mockPeriods,
  mockRuns,
  mockTaxTable,
  summaryOf,
  totalsOf,
} from '../data/payroll';
import {
  apiUrl,
  conflict,
  forbidden,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { userForRequest } from './auth';

/**
 * The mock payroll API (docs/plan/09-payroll-engine-ghana.md), with the real
 * API's rules built in:
 *
 * - A SUPERVISOR sees no payroll at all, and a GUARD sees only their own
 *   payslips. Another guard's payslip answers 404, never 403, so nobody can
 *   learn which payslips exist.
 * - The maker is never the checker. Only the person who calculated a run may
 *   submit it, and the person who submitted it may never approve or reject it.
 *   Both are second-person rules, so they answer 403 (docs/plan/05-api-contract.md).
 * - A run only moves forward, a locked run never changes, and a period never
 *   reopens. A clash with the current state answers 409.
 * - Bank and mobile money details are personal data: they appear only on the
 *   PUT that sets them and inside the bank export, and never in an error.
 *
 * It keeps its own copy of everything, so the whole month can be worked
 * through in mock mode; tests call `resetMockPayroll()` to start fresh.
 */

type Role = CurrentUser['role'];

const noStore = { 'Cache-Control': 'no-store' };

function freshCopies() {
  return {
    periods: mockPeriods.map((row) => structuredClone(row)),
    runs: mockRuns.map((row) => structuredClone(row)),
    lines: mockLines.map((row) => structuredClone(row)),
    payslips: mockPayslips.map((row) => structuredClone(row)),
    payTerms: mockPayTerms.map((row) => structuredClone(row)),
    paymentDetails: mockPaymentDetails.map((row) => structuredClone(row)),
    taxTables: [structuredClone(mockTaxTable)],
  };
}

let state = freshCopies();
/** Counts up so every new record gets its own ID, the way a database would. */
let nextId = 1;

export function resetMockPayroll(): void {
  state = freshCopies();
  nextId = 1;
}

function newId(prefix: string): string {
  nextId += 1;
  // The leading 9 keeps a new record's ID away from the seeded ones, which
  // all start with zeros; two records sharing an ID would be invisible chaos.
  return `01927c3e-${prefix}-7000-8000-9${String(nextId).padStart(11, '0')}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Signed in with one of these roles, or the matching 401/403. */
function signedInAs(request: Request, roles: Role[]) {
  const user = userForRequest(request);
  if (!user) return { refused: unauthorized('Sign in to continue.') };
  if (!roles.includes(user.role)) return { refused: forbidden() };
  return { user };
}

function idProblem(id: string, path: string) {
  return isUuid(id) ? undefined : validationProblem(path, 'Must be a valid ID.');
}

/** Like the real API's strict schemas: a field the contract does not list is a 400. */
function unknownFieldProblem(body: Record<string, unknown>, fields: string[]) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return validationProblem('body', 'Send a JSON object.');
  }
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  if (unknown === undefined) return undefined;
  // The name is the caller's own text, so it is never echoed back at length.
  const named = unknown.length <= 40 && /^[A-Za-z0-9_]+$/.test(unknown) ? unknown : 'body';
  return validationProblem(named, 'Unrecognized field.');
}

function noteProblem(value: unknown, path: string, required: boolean) {
  if (value === undefined) {
    return required ? validationProblem(path, 'Explain in 3 to 500 characters.') : undefined;
  }
  return typeof value === 'string' && value.length >= 3 && value.length <= 500
    ? undefined
    : validationProblem(path, 'Explain in 3 to 500 characters.');
}

function textProblem(value: unknown, path: string, low: number, high: number) {
  return typeof value === 'string' && value.length >= low && value.length <= high
    ? undefined
    : validationProblem(path, `Must be text of ${low} to ${high} characters.`);
}

function wholeNumberProblem(value: unknown, path: string, low: number, high: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
    ? undefined
    : validationProblem(path, `Must be a whole number from ${low} to ${high}.`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A value safe to write into the bank file: 2 to 100 characters, no tab or
 * line break, and never a leading character a spreadsheet would run as a
 * formula. A leading space is refused too, because a spreadsheet trims it
 * away on import and would then run whatever was hiding behind it. The same
 * shape the contract gives these fields, and the same one the database
 * enforces as a CHECK.
 */
const BANK_TEXT = /^[^=+@\s"-][^\t\r\n]{1,99}$/;

/** `sourceUrl` is `format: uri` in the contract, so anything else is a 400. */
function urlProblem(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
    return validationProblem(path, 'Must be a web address of up to 500 characters.');
  }
  try {
    new URL(value);
  } catch {
    return validationProblem(path, 'Must be a web address, such as https://gra.gov.gh/.');
  }
  return undefined;
}

function dateProblem(value: unknown, path: string) {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
    ? undefined
    : validationProblem(path, 'Must be a date like 2026-09-30.');
}

function lastDayOf(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** The tax table version a period ending on this day would use. */
function taxTableOn(date: string): TaxTable | undefined {
  return [...state.taxTables]
    .filter((table) => table.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

function findPeriod(periodId: string) {
  return state.periods.find((period) => period.id === periodId);
}

function findRun(runId: string) {
  return state.runs.find((run) => run.id === runId);
}

/** The employee a guard may see: their own record, and nobody else's. */
function ownEmployeeId(user: CurrentUser): string | null {
  return user.employeeId ?? null;
}

function touch(run: PayrollRun) {
  run.updatedAt = now();
}

export const payrollHandlers = [
  // --- Periods ---------------------------------------------------------

  http.get<PathParams, never, OrProblem<PayrollPeriodList>>(
    apiUrl('/payroll/periods'),
    ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const status = query.get('status');
      if (status !== null && !isOneOf(['OPEN', 'CLOSED'] as const, status)) {
        return validationProblem('status', 'Must be one of OPEN, CLOSED.');
      }
      const year = query.get('year');
      if (year !== null && !/^\d{4}$/.test(year)) {
        return validationProblem('year', 'Must be a calendar year like 2026.');
      }
      const matches = state.periods
        .filter((period) => status === null || period.status === status)
        .filter((period) => year === null || period.year === Number(year))
        .sort((a, b) => b.year - a.year || b.month - a.month);
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<PayrollPeriodList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<PathParams, CreatePayrollPeriodRequest, OrProblem<PayrollPeriod>>(
    apiUrl('/payroll/periods'),
    async ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        unknownFieldProblem(body, ['year', 'month']) ??
        wholeNumberProblem(body.year, 'year', 2020, 2100) ??
        wholeNumberProblem(body.month, 'month', 1, 12);
      if (bad) return bad;
      const year = body.year as number;
      const month = body.month as number;
      if (state.periods.some((period) => period.year === year && period.month === month)) {
        return conflict('That month already has a payroll period.');
      }
      const period: PayrollPeriod = {
        id: newId('aaaa'),
        year,
        month,
        startDate: `${year}-${String(month).padStart(2, '0')}-01`,
        endDate: lastDayOf(year, month),
        status: 'OPEN',
        closedAt: null,
        closedByUserId: null,
        lockedRunId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      state.periods.push(period);
      return HttpResponse.json<PayrollPeriod>(period, {
        status: 201,
        headers: { Location: '/api/v1/payroll/periods' },
      });
    },
  ),

  http.post<{ periodId: string }, never, OrProblem<PayrollPeriod>>(
    apiUrl('/payroll/periods/:periodId/close'),
    ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.periodId, 'periodId');
      if (bad) return bad;
      const period = findPeriod(params.periodId);
      if (!period) return notFound('No payroll period exists with this ID.');
      if (period.status === 'CLOSED') return conflict('This period is already closed.');
      period.status = 'CLOSED';
      period.closedAt = now();
      period.closedByUserId = user.id;
      period.updatedAt = period.closedAt;
      return HttpResponse.json<PayrollPeriod>(period);
    },
  ),

  // --- Runs ------------------------------------------------------------

  http.get<PathParams, never, OrProblem<PayrollRunList>>(apiUrl('/payroll/runs'), ({ request }) => {
    const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
    if (refused) return refused;
    const query = new URL(request.url).searchParams;
    const limit = readLimit(query);
    if (limit === undefined) {
      return validationProblem('limit', 'Must be a whole number from 1 to 100.');
    }
    const periodId = query.get('periodId');
    if (periodId !== null) {
      if (!isUuid(periodId)) return validationProblem('periodId', 'Must be a valid ID.');
      if (!findPeriod(periodId)) return notFound('No payroll period exists with this ID.');
    }
    const status = query.get('status');
    const statuses = ['DRAFT', 'PENDING_APPROVAL', 'LOCKED', 'PAID', 'REJECTED'] as const;
    if (status !== null && !isOneOf(statuses, status)) {
      return validationProblem('status', `Must be one of ${statuses.join(', ')}.`);
    }
    const matches = state.runs
      .filter((run) => periodId === null || run.periodId === periodId)
      .filter((run) => status === null || run.status === status)
      .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt) || b.id.localeCompare(a.id));
    const page = pageOf(matches, limit, query.get('cursor'));
    return page
      ? HttpResponse.json<PayrollRunList>(page)
      : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
  }),

  http.post<PathParams, CreatePayrollRunRequest, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs'),
    async ({ request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        unknownFieldProblem(body, ['periodId']) ??
        idProblem(String(body.periodId ?? ''), 'periodId');
      if (bad) return bad;
      const period = findPeriod(String(body.periodId));
      if (!period) return notFound('No payroll period exists with this ID.');
      if (period.status === 'CLOSED') {
        return conflict('This period is closed, so no new run can be calculated for it.');
      }
      if (
        state.runs.some(
          (run) => run.periodId === period.id && (run.status === 'LOCKED' || run.status === 'PAID'),
        )
      ) {
        return conflict('This period already has an approved run.');
      }
      const taxTable = taxTableOn(period.endDate);
      if (!taxTable) {
        return conflict('No tax table version is effective on this period last day.');
      }
      const runId = newId('bbbb');
      const calculated = calculateRun(runId, period, state.payTerms, taxTable);
      const run: PayrollRun = {
        id: runId,
        periodId: period.id,
        periodStartDate: period.startDate,
        periodEndDate: period.endDate,
        status: 'DRAFT',
        taxTableId: taxTable.id,
        taxYear: taxTable.taxYear,
        totals: calculated.totals,
        summary: summaryOf(calculated.lines, calculated.excluded),
        calculatedAt: now(),
        calculatedByUserId: user.id,
        submittedAt: null,
        submittedByUserId: null,
        submissionNote: null,
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
        updatedAt: now(),
      };
      state.runs.push(run);
      state.lines.push(...calculated.lines);
      return HttpResponse.json<PayrollRun>(run, {
        status: 201,
        headers: { Location: `/api/v1/payroll/runs/${run.id}` },
      });
    },
  ),

  http.get<{ runId: string }, never, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs/:runId'),
    ({ params, request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.runId, 'runId');
      if (bad) return bad;
      const run = findRun(params.runId);
      return run
        ? HttpResponse.json<PayrollRun>(run)
        : notFound('No payroll run exists with this ID.');
    },
  ),

  http.get<{ runId: string }, never, OrProblem<PayrollLineList>>(
    apiUrl('/payroll/runs/:runId/lines'),
    ({ params, request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.runId, 'runId');
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const employeeId = query.get('employeeId');
      if (employeeId !== null) {
        if (!isUuid(employeeId)) return validationProblem('employeeId', 'Must be a valid ID.');
        if (!mockEmployees.some((employee) => employee.id === employeeId)) {
          return notFound('No employee exists with this ID.');
        }
      }
      const matches = state.lines
        .filter((line) => line.runId === run.id)
        .filter((line) => employeeId === null || line.employee.id === employeeId)
        .sort(
          (a, b) =>
            a.employee.staffNumber.localeCompare(b.employee.staffNumber) ||
            Number(a.adjustsLineId !== null) - Number(b.adjustsLineId !== null) ||
            a.id.localeCompare(b.id),
        );
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<PayrollLineList>(page, { headers: noStore })
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<{ runId: string }, Record<string, unknown>, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs/:runId/submit'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        idProblem(params.runId, 'runId') ??
        unknownFieldProblem(body, ['note']) ??
        noteProblem(body.note, 'note', false);
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      // The maker, and only the maker: a second-person rule, so 403.
      if (run.calculatedByUserId !== user.id) return forbidden();
      if (run.status !== 'DRAFT') return conflict('Only a draft run can be submitted.');
      const period = findPeriod(run.periodId);
      if (period?.status === 'CLOSED') {
        return conflict('This period has been closed since the run was calculated.');
      }
      run.status = 'PENDING_APPROVAL';
      run.submittedAt = now();
      run.submittedByUserId = user.id;
      run.submissionNote = (body.note as string | undefined) ?? null;
      touch(run);
      return HttpResponse.json<PayrollRun>(run);
    },
  ),

  http.post<{ runId: string }, Record<string, unknown>, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs/:runId/approve'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        idProblem(params.runId, 'runId') ??
        unknownFieldProblem(body, ['note']) ??
        noteProblem(body.note, 'note', false);
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      // The maker is never the checker: a second-person rule, so 403. The
      // maker is whoever created AND submitted it, so both are compared.
      if (run.submittedByUserId === user.id || run.calculatedByUserId === user.id) {
        return forbidden();
      }
      if (run.status !== 'PENDING_APPROVAL') {
        return conflict('Only a run waiting for approval can be approved.');
      }
      const period = findPeriod(run.periodId);
      if (period?.status === 'CLOSED') {
        return conflict('This period has been closed since the run was submitted.');
      }
      if (
        state.runs.some(
          (other) =>
            other.periodId === run.periodId &&
            other.id !== run.id &&
            (other.status === 'LOCKED' || other.status === 'PAID'),
        )
      ) {
        return conflict('This period already has an approved run.');
      }
      run.status = 'LOCKED';
      run.approvedAt = now();
      run.approvedByUserId = user.id;
      run.approvalNote = (body.note as string | undefined) ?? null;
      touch(run);
      if (period) {
        period.lockedRunId = run.id;
        period.updatedAt = now();
      }
      // The lock makes one payslip per line, in the same step.
      for (const line of state.lines.filter((row) => row.runId === run.id)) {
        state.payslips.push(payslipFor(line, run));
      }
      return HttpResponse.json<PayrollRun>(run);
    },
  ),

  http.post<{ runId: string }, Record<string, unknown>, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs/:runId/reject'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        idProblem(params.runId, 'runId') ??
        unknownFieldProblem(body, ['reason']) ??
        noteProblem(body.reason, 'reason', true);
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      if (run.submittedByUserId === user.id || run.calculatedByUserId === user.id) {
        return forbidden();
      }
      if (run.status !== 'PENDING_APPROVAL') {
        return conflict('Only a run waiting for approval can be rejected.');
      }
      const period = findPeriod(run.periodId);
      if (period?.status === 'CLOSED') {
        return conflict('This period has been closed since the run was submitted.');
      }
      run.status = 'REJECTED';
      run.rejectedAt = now();
      run.rejectedByUserId = user.id;
      run.rejectionReason = body.reason as string;
      touch(run);
      return HttpResponse.json<PayrollRun>(run);
    },
  ),

  http.post<{ runId: string }, Record<string, unknown>, OrProblem<PayrollRun>>(
    apiUrl('/payroll/runs/:runId/mark-paid'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const bad =
        idProblem(params.runId, 'runId') ??
        unknownFieldProblem(body, ['paidOn', 'paymentReference', 'note']) ??
        dateProblem(body.paidOn, 'paidOn') ??
        (body.paymentReference === undefined
          ? undefined
          : textProblem(body.paymentReference, 'paymentReference', 1, 100)) ??
        noteProblem(body.note, 'note', false);
      if (bad) return bad;
      if (String(body.paidOn) > new Date().toISOString().slice(0, 10)) {
        return validationProblem('paidOn', 'The payment day cannot be in the future.');
      }
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      if (run.status !== 'LOCKED') return conflict('Only a locked run can be marked paid.');
      run.status = 'PAID';
      run.paidAt = now();
      run.paidByUserId = user.id;
      run.paidOn = String(body.paidOn);
      run.paymentReference = (body.paymentReference as string | undefined) ?? null;
      run.paymentNote = (body.note as string | undefined) ?? null;
      touch(run);
      for (const payslip of state.payslips.filter((row) => row.runId === run.id)) {
        payslip.runStatus = 'PAID';
        payslip.paidAt = run.paidAt;
      }
      return HttpResponse.json<PayrollRun>(run);
    },
  ),

  http.get<{ runId: string }, never, OrProblem<string>>(
    apiUrl('/payroll/runs/:runId/bank-export'),
    ({ params, request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.runId, 'runId');
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      if (run.status !== 'LOCKED' && run.status !== 'PAID') {
        return conflict('A bank file exists only once the run has been approved.');
      }
      return new HttpResponse(bankExportFor(run), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="payroll-run-${run.id}.csv"`,
          ...noStore,
        },
      });
    },
  ),

  http.get<{ runId: string }, never, OrProblem<PayrollStatutorySummary>>(
    apiUrl('/payroll/runs/:runId/statutory-summary'),
    ({ params, request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.runId, 'runId');
      if (bad) return bad;
      const run = findRun(params.runId);
      if (!run) return notFound('No payroll run exists with this ID.');
      const lines = state.lines.filter((line) => line.runId === run.id);
      const table = state.taxTables.find((row) => row.id === run.taxTableId) ?? mockTaxTable;
      const totals = totalsOf(lines);
      const employer = totals.totalSsnitEmployerPesewas;
      const employee = totals.totalSsnitEmployeePesewas;
      return HttpResponse.json<PayrollStatutorySummary>({
        runId: run.id,
        status: run.status,
        periodId: run.periodId,
        periodStartDate: run.periodStartDate,
        periodEndDate: run.periodEndDate,
        taxTableId: table.id,
        taxYear: table.taxYear,
        employeeCount: new Set(lines.map((line) => line.employee.id)).size,
        totalBasicPesewas: totals.totalBasicPesewas,
        ssnitEmployeeBasisPoints: table.ssnitEmployeeBasisPoints,
        totalSsnitEmployeePesewas: employee,
        ssnitEmployerBasisPoints: table.ssnitEmployerBasisPoints,
        totalSsnitEmployerPesewas: employer,
        totalSsnitPesewas: employee + employer,
        ssnitTier1BasisPoints: table.ssnitTier1BasisPoints,
        totalSsnitTier1Pesewas: lines.reduce((total, line) => total + line.ssnitTier1Pesewas, 0),
        ssnitTier2BasisPoints: table.ssnitTier2BasisPoints,
        totalSsnitTier2Pesewas: lines.reduce((total, line) => total + line.ssnitTier2Pesewas, 0),
        totalPayePesewas: totals.totalPayePesewas,
        generatedAt: now(),
      });
    },
  ),

  // --- Payslips --------------------------------------------------------

  http.get<PathParams, never, OrProblem<PayslipList>>(
    apiUrl('/payroll/payslips'),
    ({ request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'GUARD']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      for (const name of ['employeeId', 'periodId', 'runId']) {
        const value = query.get(name);
        if (value !== null && !isUuid(value)) {
          return validationProblem(name, 'Must be a valid ID.');
        }
      }
      const employeeId = query.get('employeeId');
      const own = ownEmployeeId(user);
      // A guard may only ever ask about themselves; anyone else answers 404.
      if (user.role === 'GUARD' && employeeId !== null && employeeId !== own) {
        return notFound('No employee exists with this ID.');
      }
      // A guard may only name a period or a run that one of their own
      // payslips already sits on, so the filters cannot be used to discover
      // which records exist.
      const theirs =
        user.role === 'GUARD'
          ? state.payslips.filter((payslip) => own !== null && payslip.employee.id === own)
          : null;
      const periodId = query.get('periodId');
      if (periodId !== null) {
        const known = theirs
          ? theirs.some((payslip) => payslip.periodId === periodId)
          : findPeriod(periodId) !== undefined;
        if (!known) return notFound('No payroll period exists with this ID.');
      }
      const runId = query.get('runId');
      if (runId !== null) {
        const known = theirs
          ? theirs.some((payslip) => payslip.runId === runId)
          : findRun(runId) !== undefined;
        if (!known) return notFound('No payroll run exists with this ID.');
      }
      // An employee nobody knows answers the same way for every role.
      if (employeeId !== null && !mockEmployees.some((employee) => employee.id === employeeId)) {
        return notFound('No employee exists with this ID.');
      }
      const scopeTo = user.role === 'GUARD' ? own : employeeId;
      const matches = state.payslips
        .filter((payslip) => scopeTo === null || payslip.employee.id === scopeTo)
        // A guard with no employee record simply has nothing to see.
        .filter(() => user.role !== 'GUARD' || own !== null)
        .filter((payslip) => periodId === null || payslip.periodId === periodId)
        .filter((payslip) => runId === null || payslip.runId === runId)
        .sort((a, b) => b.periodEndDate.localeCompare(a.periodEndDate) || b.id.localeCompare(a.id));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<PayslipList>(page, { headers: noStore })
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.get<{ payslipId: string }, never, OrProblem<Payslip>>(
    apiUrl('/payroll/payslips/:payslipId'),
    ({ params, request }) => {
      const found = visiblePayslip(request, params.payslipId);
      if (found.refused) return found.refused;
      return HttpResponse.json<Payslip>(found.payslip, { headers: noStore });
    },
  ),

  http.get<{ payslipId: string }, never, OrProblem<Uint8Array>>(
    apiUrl('/payroll/payslips/:payslipId/pdf'),
    ({ params, request }) => {
      const found = visiblePayslip(request, params.payslipId);
      if (found.refused) return found.refused;
      const payslip = found.payslip;
      const month = payslip.periodStartDate.slice(0, 7);
      const name =
        payslip.adjustsLineId === null
          ? `payslip-${payslip.employee.staffNumber}-${month}.pdf`
          : `payslip-${payslip.employee.staffNumber}-${month}-adjustment-${payslip.id.slice(0, 8)}.pdf`;
      return new HttpResponse(smallPdf(payslip), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${name}"`,
          ...noStore,
        },
      });
    },
  ),

  // --- Tax tables ------------------------------------------------------

  http.get<PathParams, never, OrProblem<TaxTableList>>(
    apiUrl('/payroll/tax-tables'),
    ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const taxYear = query.get('taxYear');
      if (taxYear !== null && !/^\d{4}$/.test(taxYear)) {
        return validationProblem('taxYear', 'Must be a calendar year like 2026.');
      }
      const effectiveOn = query.get('effectiveOn');
      if (effectiveOn !== null) {
        const badDate = dateProblem(effectiveOn, 'effectiveOn');
        if (badDate) return badDate;
      }
      let matches = [...state.taxTables]
        .filter((table) => taxYear === null || table.taxYear === Number(taxYear))
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id.localeCompare(a.id));
      if (effectiveOn !== null) {
        const one = matches.find((table) => table.effectiveFrom <= effectiveOn);
        matches = one ? [one] : [];
      }
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<TaxTableList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<PathParams, CreateTaxTableRequest, OrProblem<TaxTable>>(
    apiUrl('/payroll/tax-tables'),
    async ({ request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const fields = [
        'taxYear',
        'effectiveFrom',
        'effectiveTo',
        'ssnitEmployeeBasisPoints',
        'ssnitEmployerBasisPoints',
        'ssnitTier1BasisPoints',
        'ssnitTier2BasisPoints',
        'bands',
        'sourceName',
        'sourceUrl',
        'sourceCheckedOn',
      ];
      const bad =
        unknownFieldProblem(body, fields) ??
        wholeNumberProblem(body.taxYear, 'taxYear', 2020, 2100) ??
        dateProblem(body.effectiveFrom, 'effectiveFrom') ??
        wholeNumberProblem(body.ssnitEmployeeBasisPoints, 'ssnitEmployeeBasisPoints', 0, 10_000) ??
        wholeNumberProblem(body.ssnitEmployerBasisPoints, 'ssnitEmployerBasisPoints', 0, 10_000) ??
        wholeNumberProblem(body.ssnitTier1BasisPoints, 'ssnitTier1BasisPoints', 0, 10_000) ??
        wholeNumberProblem(body.ssnitTier2BasisPoints, 'ssnitTier2BasisPoints', 0, 10_000) ??
        dateProblem(body.sourceCheckedOn, 'sourceCheckedOn') ??
        textProblem(body.sourceName, 'sourceName', 2, 200) ??
        urlProblem(body.sourceUrl, 'sourceUrl') ??
        (body.effectiveTo === undefined || body.effectiveTo === null
          ? undefined
          : dateProblem(body.effectiveTo, 'effectiveTo')) ??
        bandsProblem(body.bands);
      if (bad) return bad;
      // Decision 26: Tier 1 and Tier 2 are a split of the same contribution,
      // so together they must equal the employee and employer shares together.
      // The engine derives Tier 2 from the other three, so a table where they
      // disagree would make the statutory summary fail to reconcile.
      if (
        Number(body.ssnitTier1BasisPoints) + Number(body.ssnitTier2BasisPoints) !==
        Number(body.ssnitEmployeeBasisPoints) + Number(body.ssnitEmployerBasisPoints)
      ) {
        return validationProblem(
          'ssnitTier2BasisPoints',
          'Tier 1 and Tier 2 together must equal the employee and employer shares together, because the tiers are a split of the same contribution.',
        );
      }
      if (typeof body.effectiveTo === 'string' && body.effectiveTo < String(body.effectiveFrom)) {
        return validationProblem('effectiveTo', 'The last day cannot be before the first day.');
      }
      if (String(body.sourceCheckedOn) > new Date().toISOString().slice(0, 10)) {
        return validationProblem('sourceCheckedOn', 'The day checked cannot be in the future.');
      }
      if (state.taxTables.some((table) => table.effectiveFrom === body.effectiveFrom)) {
        return conflict('A tax table version already starts on that day.');
      }
      const table: TaxTable = {
        id: newId('cccc'),
        taxYear: body.taxYear as number,
        effectiveFrom: String(body.effectiveFrom),
        effectiveTo: (body.effectiveTo as string | undefined) ?? null,
        ssnitEmployeeBasisPoints: body.ssnitEmployeeBasisPoints as number,
        ssnitEmployerBasisPoints: body.ssnitEmployerBasisPoints as number,
        ssnitTier1BasisPoints: body.ssnitTier1BasisPoints as number,
        ssnitTier2BasisPoints: body.ssnitTier2BasisPoints as number,
        bands: body.bands as TaxTable['bands'],
        sourceName: String(body.sourceName),
        sourceUrl: String(body.sourceUrl),
        sourceCheckedOn: String(body.sourceCheckedOn),
        createdAt: now(),
        createdByUserId: user.id,
      };
      state.taxTables.push(table);
      return HttpResponse.json<TaxTable>(table, {
        status: 201,
        headers: { Location: '/api/v1/payroll/tax-tables' },
      });
    },
  ),

  // --- Pay terms and payment details -----------------------------------

  http.get<{ employeeId: string }, never, OrProblem<EmployeePayTermsList>>(
    apiUrl('/employees/:employeeId/pay-terms'),
    ({ params, request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const bad = idProblem(params.employeeId, 'employeeId');
      if (bad) return bad;
      // The contract decides a bad request before a missing record (400 then
      // 404, docs/plan/05-api-contract.md), and the API validates its query
      // before it looks anything up. The order is checked, so it is kept.
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const effectiveOn = query.get('effectiveOn');
      if (effectiveOn !== null) {
        const badDate = dateProblem(effectiveOn, 'effectiveOn');
        if (badDate) return badDate;
      }
      if (!mockEmployees.some((employee) => employee.id === params.employeeId)) {
        return notFound('No employee exists with this ID.');
      }
      let matches = state.payTerms
        .filter((row) => row.employeeId === params.employeeId)
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id.localeCompare(a.id));
      if (effectiveOn !== null) {
        const one = matches.find((row) => row.effectiveFrom <= effectiveOn);
        matches = one ? [one] : [];
      }
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<EmployeePayTermsList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.put<{ employeeId: string }, Record<string, unknown>, OrProblem<EmployeePayTerms>>(
    apiUrl('/employees/:employeeId/pay-terms'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const money = [
        'basicMonthlyPesewas',
        'overtimeHourlyPesewas',
        'taxableAllowancePesewas',
        'nonTaxableAllowancePesewas',
        'otherDeductionPesewas',
      ];
      const bad =
        idProblem(params.employeeId, 'employeeId') ??
        unknownFieldProblem(body, ['effectiveFrom', ...money]) ??
        dateProblem(body.effectiveFrom, 'effectiveFrom') ??
        money
          .map((name) => wholeNumberProblem(body[name], name, 0, 100_000_000))
          .find((problem) => problem !== undefined);
      if (bad) return bad;
      if (!mockEmployees.some((employee) => employee.id === params.employeeId)) {
        return notFound('No employee exists with this ID.');
      }
      if (
        state.payTerms.some(
          (row) => row.employeeId === params.employeeId && row.effectiveFrom === body.effectiveFrom,
        )
      ) {
        return conflict('This employee already has pay terms starting on that day.');
      }
      // Never an edit: a change is always a new row.
      const terms: EmployeePayTerms = {
        id: newId('dddd'),
        employeeId: params.employeeId,
        effectiveFrom: String(body.effectiveFrom),
        basicMonthlyPesewas: body.basicMonthlyPesewas as number,
        overtimeHourlyPesewas: body.overtimeHourlyPesewas as number,
        taxableAllowancePesewas: body.taxableAllowancePesewas as number,
        nonTaxableAllowancePesewas: body.nonTaxableAllowancePesewas as number,
        otherDeductionPesewas: body.otherDeductionPesewas as number,
        createdAt: now(),
        createdByUserId: user.id,
      };
      state.payTerms.push(terms);
      return HttpResponse.json<EmployeePayTerms>(terms, {
        status: 201,
        headers: { Location: `/api/v1/employees/${params.employeeId}/pay-terms` },
      });
    },
  ),

  http.put<{ employeeId: string }, Record<string, unknown>, OrProblem<EmployeePaymentDetails>>(
    apiUrl('/employees/:employeeId/payment-details'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const body: Record<string, unknown> = await request.json();
      const fields = ['bankName', 'accountName', 'accountNumber', 'momoNumber'];
      const bad =
        idProblem(params.employeeId, 'employeeId') ??
        unknownFieldProblem(body, fields) ??
        // Only the field is ever named, never the value the person typed.
        nullableTextProblem(body.bankName, 'bankName', BANK_TEXT) ??
        nullableTextProblem(body.accountName, 'accountName', BANK_TEXT) ??
        nullableTextProblem(body.accountNumber, 'accountNumber', /^[0-9]{5,20}$/) ??
        nullableTextProblem(body.momoNumber, 'momoNumber', /^\+233\d{9}$/);
      if (bad) return bad;
      if (!mockEmployees.some((employee) => employee.id === params.employeeId)) {
        return notFound('No employee exists with this ID.');
      }
      const details: EmployeePaymentDetails = {
        employeeId: params.employeeId,
        bankName: (body.bankName as string | null) ?? null,
        accountName: (body.accountName as string | null) ?? null,
        accountNumber: (body.accountNumber as string | null) ?? null,
        momoNumber: (body.momoNumber as string | null) ?? null,
        updatedAt: now(),
        updatedByUserId: user.id,
      };
      const existing = state.paymentDetails.findIndex(
        (row) => row.employeeId === params.employeeId,
      );
      if (existing === -1) state.paymentDetails.push(details);
      else state.paymentDetails[existing] = details;
      return HttpResponse.json<EmployeePaymentDetails>(details, { headers: noStore });
    },
  ),
];

/** A payslip the caller may see, or the refusal the real API would send. */
function visiblePayslip(request: Request, payslipId: string) {
  const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'GUARD']);
  if (refused) return { refused };
  const bad = idProblem(payslipId, 'payslipId');
  if (bad) return { refused: bad };
  const payslip = state.payslips.find((row) => row.id === payslipId);
  // Another guard's payslip is hidden the same way an unknown ID is.
  if (!payslip || (user.role === 'GUARD' && payslip.employee.id !== ownEmployeeId(user))) {
    return { refused: notFound('No payslip exists with this ID.') };
  }
  return { payslip };
}

function payslipFor(line: PayrollLine, run: PayrollRun): Payslip {
  const table = state.taxTables.find((row) => row.id === run.taxTableId) ?? mockTaxTable;
  return {
    id: newId('ffff'),
    lineId: line.id,
    runId: run.id,
    periodId: run.periodId,
    periodStartDate: run.periodStartDate,
    periodEndDate: run.periodEndDate,
    employee: line.employee,
    runStatus: run.status,
    paidAt: run.paidAt,
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
    ssnitEmployeeBasisPoints: table.ssnitEmployeeBasisPoints,
    ssnitEmployeePesewas: line.ssnitEmployeePesewas,
    ssnitEmployerBasisPoints: table.ssnitEmployerBasisPoints,
    ssnitEmployerPesewas: line.ssnitEmployerPesewas,
    chargeableIncomePesewas: line.chargeableIncomePesewas,
    payePesewas: line.payePesewas,
    otherDeductionsPesewas: line.otherDeductionsPesewas,
    netPayPesewas: line.netPayPesewas,
    taxTableId: table.id,
    taxYear: table.taxYear,
    adjustsLineId: line.adjustsLineId,
    adjustmentNote: line.adjustmentNote,
    pdfGeneratedAt: now(),
    pdfSizeBytes: 21_480,
    pdfSha256: `${'0'.repeat(56)}${line.id.slice(-8)}`.slice(0, 64),
  };
}

function bandsProblem(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    return validationProblem('bands', 'Send at least one band.');
  }
  if (value.length > 20) {
    return validationProblem('bands', 'Send at most 20 bands.');
  }
  for (const [index, band] of value.entries()) {
    // The API's shared formatter joins a validation path with dots, so a
    // dashboard matching on `bands.0.widthPesewas` finds the same thing here.
    const at = `bands.${index}`;
    if (typeof band !== 'object' || band === null) {
      return validationProblem(at, 'Each band needs an ordinal, a width and a rate.');
    }
    const row = band as Record<string, unknown>;
    const extra = Object.keys(row).find(
      (key) => !['ordinal', 'widthPesewas', 'rateBasisPoints'].includes(key),
    );
    if (extra !== undefined) {
      return validationProblem(at, 'A band holds only an ordinal, a width and a rate.');
    }
    if (row.ordinal !== index + 1) {
      return validationProblem(`${at}.ordinal`, 'Ordinals run from 1 upwards with no gaps.');
    }
    const last = index === value.length - 1;
    if (row.widthPesewas === null && !last) {
      return validationProblem(`${at}.widthPesewas`, 'Only the last band may have no width.');
    }
    // Without an open top band the highest earners would be silently untaxed.
    if (last && row.widthPesewas !== null) {
      return validationProblem(
        `${at}.widthPesewas`,
        'The last band has no width, because it has no upper limit.',
      );
    }
    if (row.widthPesewas !== null) {
      const badWidth = wholeNumberProblem(row.widthPesewas, `${at}.widthPesewas`, 1, 100_000_000);
      if (badWidth) return badWidth;
    }
    const badRate = wholeNumberProblem(row.rateBasisPoints, `${at}.rateBasisPoints`, 0, 10_000);
    if (badRate) return badRate;
  }
  return undefined;
}

function nullableTextProblem(value: unknown, path: string, shape: RegExp) {
  if (value === null) return undefined;
  return typeof value === 'string' && shape.test(value)
    ? undefined
    : validationProblem(path, 'This value is not in the right format.');
}

/**
 * One cell of the bank file, as RFC 4180 says: always quoted, with every
 * quote inside it doubled, so a name holding a comma, a quote or a line break
 * can never break a row apart or add one. A value that starts with a
 * character a spreadsheet would run as a formula is prefixed with an
 * apostrophe, so it stays text.
 */
function csvCell(value: string | null | undefined): string {
  const text = value === null || value === undefined ? '' : value;
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** The bank file, exactly as the contract documents its columns. */
function bankExportFor(run: PayrollRun): string {
  const header = [
    'staff_number',
    'full_name',
    'bank_name',
    'account_name',
    'account_number',
    'momo_number',
    'net_pay_pesewas',
    'net_pay_ghs',
    'employee_reference',
    'details_changed_after_approval',
  ]
    .map(csvCell)
    .join(',');
  const byEmployee = new Map<string, { staffNumber: string; fullName: string; net: number }>();
  for (const line of state.lines.filter((row) => row.runId === run.id)) {
    const found = byEmployee.get(line.employee.id) ?? {
      staffNumber: line.employee.staffNumber,
      fullName: line.employee.fullName,
      net: 0,
    };
    found.net += line.netPayPesewas;
    byEmployee.set(line.employee.id, found);
  }
  const month = run.periodEndDate.slice(0, 7);
  const rows = [...byEmployee.entries()]
    // A bank file cannot take a negative payment; the line still shows it.
    .filter(([, person]) => person.net > 0)
    .sort((a, b) => a[1].staffNumber.localeCompare(b[1].staffNumber))
    .map(([employeeId, person]) => {
      const details = state.paymentDetails.find((row) => row.employeeId === employeeId);
      const ghs = (person.net / 100).toFixed(2);
      // The destination is not covered by the approval, so the file says when
      // it moved afterwards (see decision 22 in the payroll design page).
      const movedAfterApproval =
        run.approvedAt !== null && details !== undefined && details.updatedAt > run.approvedAt;
      return [
        person.staffNumber,
        person.fullName,
        details?.bankName,
        details?.accountName,
        details?.accountNumber,
        details?.momoNumber,
        String(person.net),
        ghs,
        `SAMTEC-${month}-${person.staffNumber}`,
        movedAfterApproval ? 'yes' : 'no',
      ]
        .map(csvCell)
        .join(',');
    });
  return [header, ...rows].join('\n');
}

/**
 * A very small but genuinely valid PDF, so the download works in the browser
 * during a demo. The real API builds a full payslip with pdfkit.
 */
function smallPdf(payslip: Payslip): Uint8Array {
  const text = [
    `SAMTEC payslip  ${payslip.employee.staffNumber}`,
    `${payslip.employee.fullName}`,
    `Period ${payslip.periodStartDate} to ${payslip.periodEndDate}`,
    `Gross ${(payslip.grossPesewas / 100).toFixed(2)} GHS`,
    `Net ${(payslip.netPayPesewas / 100).toFixed(2)} GHS`,
    'Mock data only.',
  ];
  const lines = text
    .map((line, index) => {
      // Brackets and backslashes end a PDF string, so they are escaped.
      const safe = line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
      return `BT /F1 12 Tf 60 ${760 - index * 20} Td (${safe}) Tj ET`;
    })
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Exported for the tests, which check the period length the engine uses. */
export { daysBetweenInclusive };
