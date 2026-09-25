/**
 * The words the payroll screens use, in one place.
 *
 * Every status a run can be in, and what each one means for the person reading
 * it. A payroll officer should not have to guess whether `PENDING_APPROVAL`
 * means somebody is waiting on them, so the description says so.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md.
 */
import type {
  PayrollPeriodStatus,
  PayrollRunExclusionReason,
  PayrollRunStatus,
} from '@samtec/contracts';

/** Every run status, in the order a run moves through them. */
export const RUN_STATUSES: readonly PayrollRunStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'LOCKED',
  'PAID',
  'REJECTED',
];

export const runStatusLabels: Record<PayrollRunStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Waiting for approval',
  LOCKED: 'Approved',
  PAID: 'Paid',
  REJECTED: 'Rejected',
};

/** What the status means for whoever is looking at it. */
export const runStatusDescriptions: Record<PayrollRunStatus, string> = {
  DRAFT: 'Worked out but not sent to anybody. Calculating again makes a new draft.',
  PENDING_APPROVAL: 'Waiting for an administrator who did not prepare it to approve or reject it.',
  LOCKED: 'Approved and frozen. Payslips are made. Nothing about it can change again.',
  PAID: 'The money has gone, and the payment is recorded.',
  REJECTED: 'Sent back for good. The answer is to calculate a fresh draft.',
};

/**
 * How a status is coloured. Approved and paid are settled; waiting is the one
 * that needs somebody; rejected is over.
 */
export const runStatusTone: Record<PayrollRunStatus, 'neutral' | 'waiting' | 'good' | 'ended'> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'waiting',
  LOCKED: 'good',
  PAID: 'good',
  REJECTED: 'ended',
};

export const periodStatusLabels: Record<PayrollPeriodStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
};

/** Why somebody was left off a run, said plainly enough to act on. */
export const exclusionReasonLabels: Record<PayrollRunExclusionReason, string> = {
  SUSPENDED: 'Suspended, so not paid this month',
  NO_PAY_TERMS: 'No pay terms on file — add them before the next run',
};

export function isRunStatus(value: string): value is PayrollRunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/** The month a period covers, as somebody would say it: "September 2026". */
export function monthName(year: number, month: number): string {
  const at = new Date(Date.UTC(year, month - 1, 1));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(at);
}

/**
 * Whether this person may decide about this run.
 *
 * The rule the whole phase exists for: whoever calculated or submitted a run
 * may never approve or reject it. The API refuses it and so does the database,
 * but the screen should not offer a button that cannot work — and it should say
 * why, rather than hiding it and leaving somebody wondering.
 */
export function mayDecide(
  run: { calculatedByUserId: string; submittedByUserId: string | null },
  userId: string,
): boolean {
  return run.calculatedByUserId !== userId && run.submittedByUserId !== userId;
}

/** Whether this person is the one who prepared the run, and so the one to submit it. */
export function isTheMaker(run: { calculatedByUserId: string }, userId: string): boolean {
  return run.calculatedByUserId === userId;
}
