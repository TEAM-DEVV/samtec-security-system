/**
 * The company's own receipt for a paid run, as a PDF.
 *
 * Design: the owner's request that the company receive a receipt of its own
 * once salaries are paid, the same way a worker receives a payslip. **Not a
 * payslip** — it names no single figure a worker would check, only what left
 * the company's account and where it went: the paying account, one row per
 * worker paid, and the totals.
 *
 * Built the way `payslip-pdf.ts` and `run-summary-pdf.ts` build PDFs: no
 * library, reusing `assemblePdf` so there is one PDF writer in this codebase,
 * not three.
 *
 * **Every destination is masked.** A worker's bank account is never printed
 * in full — only its last four digits, through `maskToLastFour` — and a
 * mobile money number is named by the same four digits rather than written
 * out (`../../common/masking.ts`). The paying account is masked the same way.
 */
import { lastFour } from '../../common/masking.js';
import {
  assemblePdf,
  type BuiltPdf,
  type Line,
  money,
  wrapToWidth,
} from './payslip-pdf.js';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const COURIER_WIDTH = 0.6;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN;

/** Room reserved at the foot of the page for the totals and the closing note. */
const FOOTER_RESERVE = 96;

/** One worker this run paid. Only what the receipt needs to name their row. */
export interface PaymentReceiptWorkerInput {
  staffNumber: string;
  fullName: string;
  netPayPesewas: number;
  /** Where their pay went, if a bank account is on file. */
  accountNumber: string | null;
  /** Where their pay went, if mobile money is on file and no bank account is. */
  momoNumber: string | null;
}

/** Everything the receipt prints. */
export interface PaymentReceiptForPdf {
  companyName: string;
  periodStartDate: string;
  periodEndDate: string;
  paidOn: string;
  paymentReference: string | null;
  payingBankName: string | null;
  payingBranch: string | null;
  /** Already masked: this builder never sees a real account number for the paying account. */
  payingAccountNumberMasked: string | null;
  /** In the order they should be printed — sorted by staff number, as the bank file is. */
  workers: readonly PaymentReceiptWorkerInput[];
}

/**
 * One worker's destination, exactly as decision 25 and the bank export
 * reason about it: never the number itself, only enough to recognise it.
 */
export function destinationFor(worker: PaymentReceiptWorkerInput): string {
  if (worker.accountNumber !== null) {
    return `**** ${lastFour(worker.accountNumber)}`;
  }
  if (worker.momoNumber !== null) {
    return `mobile money ending ${lastFour(worker.momoNumber)}`;
  }
  return 'no payment details on file';
}

/** A label on the left and an amount right-aligned to the page's edge, in Courier. */
function amountRow(y: number, label: string, amount: string, bold = false): Line[] {
  const size = 10;
  return [
    { x: MARGIN, y, size, font: bold ? 'HB' : 'H', text: label },
    {
      x: PAGE_WIDTH - MARGIN - amount.length * COURIER_WIDTH * size,
      y,
      size,
      font: 'C',
      text: amount,
    },
  ];
}

/**
 * One worker's row. The amount sits beside the first line always; a name and
 * destination long enough to wrap only pushes the row taller, never off the
 * page — the same reasoning `wrapToWidth` exists for in `payslip-pdf.ts`.
 */
function workerRow(y: number, worker: PaymentReceiptWorkerInput): { lines: Line[]; nextY: number } {
  const size = 9;
  const amount = money(worker.netPayPesewas);
  const amountWidth = amount.length * COURIER_WIDTH * size;
  // Plain ASCII only: `textForPdf` replaces anything outside Latin-1 with a
  // question mark, and an em dash's own code point is well past 255.
  const label = `${worker.staffNumber}  ${worker.fullName}  (${destinationFor(worker)})`;
  const wrapped = wrapToWidth(label, size, USABLE_WIDTH - amountWidth - 10);

  const lines: Line[] = [
    { x: MARGIN, y, size, font: 'H', text: wrapped[0] ?? label },
    { x: PAGE_WIDTH - MARGIN - amountWidth, y, size, font: 'C', text: amount },
  ];
  let rowY = y;
  for (const continued of wrapped.slice(1)) {
    rowY -= 12;
    lines.push({ x: MARGIN + 12, y: rowY, size, font: 'H', text: continued });
  }
  return { lines, nextY: rowY - 13 };
}

/** Lays the receipt out and assembles it. */
export function buildPaymentReceiptPdf(receipt: PaymentReceiptForPdf): BuiltPdf {
  const lines: Line[] = [];
  const rules: number[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  lines.push({ x: MARGIN, y, size: 18, font: 'HB', text: 'SAMTEC' });
  lines.push({ x: MARGIN + 90, y, size: 11, font: 'H', text: 'Salary payment receipt' });
  y -= 26;

  lines.push({ x: MARGIN, y, size: 12, font: 'HB', text: receipt.companyName });
  y -= 16;
  lines.push({
    x: MARGIN,
    y,
    size: 10,
    font: 'H',
    text: `For ${receipt.periodStartDate} to ${receipt.periodEndDate}`,
  });
  y -= 14;
  lines.push({
    x: MARGIN,
    y,
    size: 9,
    font: 'H',
    text:
      receipt.paymentReference === null
        ? `Paid on ${receipt.paidOn}`
        : `Paid on ${receipt.paidOn}, reference ${receipt.paymentReference}`,
  });
  y -= 20;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Paid from' });
  y -= 16;
  lines.push({
    x: MARGIN,
    y,
    size: 9,
    font: 'H',
    text:
      receipt.payingBankName === null
        ? 'No bank account was on file for this company when the receipt was made.'
        : `${receipt.payingBankName}${receipt.payingBranch === null ? '' : `, ${receipt.payingBranch}`}, account ${receipt.payingAccountNumberMasked ?? '****'}`,
  });
  y -= 24;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Workers paid' });
  y -= 18;

  let shown = 0;
  for (const worker of receipt.workers) {
    // Stops with room to spare for the totals and the closing note below,
    // whatever mix of plain and wrapped rows came before it. Nobody is
    // silently short-changed by this: the totals beneath are always the sum
    // of every worker paid, not just the rows this page had room to print.
    if (y - FOOTER_RESERVE < MARGIN) {
      break;
    }
    const row = workerRow(y, worker);
    lines.push(...row.lines);
    y = row.nextY;
    shown += 1;
  }
  if (shown < receipt.workers.length) {
    lines.push({
      x: MARGIN,
      y,
      size: 9,
      font: 'H',
      text: `and ${receipt.workers.length - shown} more, listed in full in the bank file.`,
    });
    y -= 13;
  }

  rules.push(y + 8);
  y -= 4;
  lines.push(...amountRow(y, 'Total workers paid', String(receipt.workers.length), true));
  y -= 15;
  const totalNetPayPesewas = receipt.workers.reduce((total, worker) => total + worker.netPayPesewas, 0);
  lines.push(...amountRow(y, 'Total net pay', money(totalNetPayPesewas), true));
  y -= 24;

  lines.push({
    x: MARGIN,
    y,
    size: 8,
    font: 'H',
    text: "This is the company's own record that these salaries were paid, out of the account above.",
  });

  return assemblePdf(lines, rules);
}

/** What the file is called when somebody saves it. */
export function paymentReceiptFileName(periodEndDate: string): string {
  return `payroll-payment-receipt-${periodEndDate.slice(0, 7)}.pdf`;
}
