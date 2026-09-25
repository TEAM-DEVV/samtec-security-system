import type { ProblemDetails, ReportsOverview, UserRole } from '@samtec/contracts';
import { HttpResponse, http } from 'msw';
import { mockEmployees } from '../data/employees';
import { apiUrl, forbidden, unauthorized, validationProblem } from '../helpers';
import { userForRequest } from './auth';
import { payrollMockState } from './payroll';

/**
 * The Reports mock (Phase 6): the figures the dashboard shows, and the two CSV
 * downloads.
 *
 * The numbers come from the same mock state the payroll handlers use, so the
 * dashboard's figures and its payroll pages can never disagree — which is the
 * rule the real API follows too.
 */

type OrProblem<T> = T | ProblemDetails | string;

const noStore = { 'Cache-Control': 'no-store' };

function signedInAs(request: Request, roles: UserRole[]) {
  const user = userForRequest(request);
  if (!user) return { refused: unauthorized('Sign in to read reports.') };
  if (!roles.includes(user.role)) return { refused: forbidden() };
  return { user, refused: undefined };
}

/** Every cell quoted, and anything a spreadsheet would run made safe. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export const reportHandlers = [
  http.get<never, never, OrProblem<ReportsOverview>>(apiUrl('/reports/overview'), ({ request }) => {
    const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR']);
    if (refused) return refused;

    const now = new Date();
    const approved = payrollMockState().runs.filter(
      (run) => run.status === 'LOCKED' || run.status === 'PAID',
    );

    return HttpResponse.json<ReportsOverview>({
      present: {
        // A settled number in mock mode, so a demo reads the same every time.
        onShift: 7,
        activeEmployees: mockEmployees.filter((one) => one.status === 'ACTIVE').length,
        asOf: now.toISOString(),
      },
      absence: {
        fromDate: new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10),
        toDate: now.toISOString().slice(0, 10),
        scheduledMinutes: 268_800,
        workedMinutes: 262_080,
        // 6,720 minutes of 268,800 is 2.5%.
        basisPoints: 250,
      },
      payrollCost: approved.map((run) => {
        const lines = payrollMockState().lines.filter((line) => line.runId === run.id);
        const sum = (pick: (line: (typeof lines)[number]) => number) =>
          lines.reduce((total, line) => total + pick(line), 0);
        const employerSsnit = sum((line) => line.ssnitEmployerPesewas);
        return {
          periodId: run.periodId,
          year: Number(run.periodStartDate.slice(0, 4)),
          month: Number(run.periodStartDate.slice(5, 7)),
          runId: run.id,
          employeeCount: new Set(lines.map((line) => line.employee.id)).size,
          grossPesewas: sum((line) => line.grossPesewas),
          netPayPesewas: sum((line) => line.netPayPesewas),
          employerSsnitPesewas: employerSsnit,
          statutoryPesewas:
            sum((line) => line.ssnitEmployeePesewas) +
            employerSsnit +
            sum((line) => line.payePesewas),
        };
      }),
      generatedAt: now.toISOString(),
    });
  }),

  http.get<never, never, OrProblem<string>>(apiUrl('/reports/attendance.csv'), ({ request }) => {
    const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR']);
    if (refused) return refused;

    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (from === null || !iso.test(from)) {
      return validationProblem('from', 'Must be a date like 2026-09-01.');
    }
    if (to === null || !iso.test(to)) {
      return validationProblem('to', 'Must be a date like 2026-09-30.');
    }
    if (to < from) {
      return validationProblem('to', 'The last day cannot be before the first.');
    }
    const days =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) +
      1;
    if (days > 92) {
      return validationProblem('to', 'A report covers at most 92 days. Ask for a shorter range.');
    }

    const header = [
      'work_date',
      'staff_number',
      'full_name',
      'site',
      'worked_minutes',
      'worked_hours',
      'clocked_in_by',
    ];
    const rows = mockEmployees
      .slice(0, 5)
      .map((employee, index) =>
        [
          from,
          employee.staffNumber,
          employee.fullName,
          'Accra Head Office',
          String(480 + index * 30),
          ((480 + index * 30) / 60).toFixed(2),
          'Face or fingerprint',
        ]
          .map(csvCell)
          .join(','),
      );

    return new HttpResponse([header.map(csvCell).join(','), ...rows].join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance-${from}-to-${to}.csv"`,
        ...noStore,
      },
    });
  }),

  http.get<never, never, OrProblem<string>>(apiUrl('/reports/payroll-cost.csv'), ({ request }) => {
    // A supervisor reads attendance but never payroll, here as in the real API.
    const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
    if (refused) return refused;

    const header = [
      'year',
      'month',
      'people_paid',
      'gross_pesewas',
      'gross_ghs',
      'net_pay_pesewas',
      'net_pay_ghs',
      'employer_ssnit_pesewas',
      'owed_to_the_state_pesewas',
    ];
    const rows = payrollMockState()
      .runs.filter((run) => run.status === 'LOCKED' || run.status === 'PAID')
      .map((run) => {
        const lines = payrollMockState().lines.filter((line) => line.runId === run.id);
        const sum = (pick: (line: (typeof lines)[number]) => number) =>
          lines.reduce((total, line) => total + pick(line), 0);
        const gross = sum((line) => line.grossPesewas);
        const net = sum((line) => line.netPayPesewas);
        const employerSsnit = sum((line) => line.ssnitEmployerPesewas);
        return [
          run.periodStartDate.slice(0, 4),
          run.periodStartDate.slice(5, 7),
          String(new Set(lines.map((line) => line.employee.id)).size),
          String(gross),
          (gross / 100).toFixed(2),
          String(net),
          (net / 100).toFixed(2),
          String(employerSsnit),
          String(
            sum((line) => line.ssnitEmployeePesewas) +
              employerSsnit +
              sum((line) => line.payePesewas),
          ),
        ]
          .map(csvCell)
          .join(',');
      });

    return new HttpResponse([header.map(csvCell).join(','), ...rows].join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="payroll-cost.csv"',
        ...noStore,
      },
    });
  }),
];
