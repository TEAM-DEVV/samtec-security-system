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
  PENDING_APPROVAL: 'Waiting for an administrator to approve or reject it, with their password.',
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

/** Whether this person is the one who prepared the run, and so the one to submit it. */
export function isTheMaker(run: { calculatedByUserId: string }, userId: string): boolean {
  return run.calculatedByUserId === userId;
}

/** The contract's cap on one pay-terms money field: GHS 1,000,000. */
export const MAX_MONEY_PESEWAS = 100_000_000;

/** A plain amount typed into a pay-terms box, like "1200" or "1234.56". */
const CEDIS_INPUT = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * Turns a cedis amount typed into a form, such as "1,234.56", into whole
 * pesewas (123456) — or `null` when it is not a plain non-negative amount of
 * at most two decimal places and within the API's cap. Pure integer
 * arithmetic throughout, never `parseFloat(x) * 100`, so the result is exact
 * to the pesewa and never the value one float multiplication away from it.
 */
export function parseCedisInput(value: string): number | null {
  const trimmed = value.trim().replaceAll(',', '');
  if (!CEDIS_INPUT.test(trimmed)) {
    return null;
  }
  const [wholePart, fractionPart = ''] = trimmed.split('.');
  const pesewasPart = fractionPart.padEnd(2, '0');
  const amountPesewas = Number(wholePart) * 100 + Number(pesewasPart);
  return amountPesewas <= MAX_MONEY_PESEWAS ? amountPesewas : null;
}

/** The reverse of `parseCedisInput`, to pre-fill a form field: 123456 → "1234.56". */
export function pesewasToCedisInput(amountPesewas: number): string {
  const cedis = Math.trunc(amountPesewas / 100);
  const pesewas = amountPesewas % 100;
  return `${cedis}.${String(pesewas).padStart(2, '0')}`;
}
