/**
 * A client invoice for one site and one calendar month, as a one-page PDF.
 *
 * It reuses the page assembler in `payroll/payslip-pdf.ts`, so there is one
 * implementation of the PDF format in this codebase and not two. See that
 * file for why there is no PDF library here at all.
 *
 * **Money.** Every amount is computed here, from the worked minutes and the
 * hourly rate, rounded half up — the same rule `payroll/pay-calculation.ts`
 * rounds overtime pay by. The subtotal is the sum of the printed amount
 * column, never a separate calculation from the total hours, so a client
 * checking the page with a calculator gets the same number this prints.
 *
 * **The currency sign.** The dashboard shows money as `GH₵ 1,234.56`
 * (`apps/web/src/lib/format.ts`), but the Ghana cedi sign is outside Latin-1,
 * so `textForPdf` would turn it into `?` the same way it guards any other
 * character WinAnsi cannot carry. This prints the currency code `GHS`
 * instead, which every reader shows correctly.
 */
import {
  assemblePdf,
  type BuiltPdf,
  type Line,
  money,
  wrapToWidth,
} from '../payroll/payslip-pdf.js';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const COURIER_WIDTH = 0.6;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;

// The table's columns, worked out right to left so the widest, most important
// figure — the amount — always lands exactly on the page's own right margin,
// the same edge every other money figure in this codebase right-aligns to.
// Each budget is generous for what it holds: a staff number is always
// exactly 9 characters, hours comfortably covers even a very long month, and
// the two money columns comfortably cover any realistic hourly rate.
const AMOUNT_RIGHT = RIGHT_EDGE;
const RATE_RIGHT = AMOUNT_RIGHT - 94;
const HOURS_RIGHT = RATE_RIGHT - 82;
const STAFF_X = HOURS_RIGHT - 109;
const NAME_X = MARGIN;
const NAME_WIDTH = STAFF_X - NAME_X - 14;

/**
 * How much room the totals and the closing note always need at the bottom of
 * the page. A row stops being printed once there is not this much space left
 * above the margin, and the rest are summarised in one line instead.
 */
const BOTTOM_RESERVED = 110;

/** One worker's share of the month: minutes worked, at the one rate the whole invoice bills. */
export interface InvoiceLineForPdf {
  staffNumber: string;
  fullName: string;
  workedMinutes: number;
}

/** Everything printed on a client invoice. Only what the reader can see. */
export interface SiteInvoiceForPdf {
  /** The security company issuing the invoice. */
  issuerName: string;
  /** The client being billed. */
  clientName: string;
  siteCode: string;
  siteName: string;
  /** The billed month, as `YYYY-MM`. */
  month: string;
  invoiceNumber: string;
  /** The day the PDF was built, as `YYYY-MM-DD`. */
  issuedOn: string;
  hourlyRatePesewas: number;
  lines: readonly InvoiceLineForPdf[];
}

/**
 * Minutes billed at a rate, in pesewas, rounded half up.
 *
 * Both inputs are always zero or more here — a confirmed shift cannot have
 * negative minutes, and the rate is validated above zero before this is ever
 * called — so this needs none of the sign-handling `divideHalfUp` in
 * `payroll/pay-calculation.ts` does for a payslip's negative adjustment
 * lines. BigInt keeps the rounding exact: a worker's pesewas are never found
 * by floating-point division.
 */
export function lineAmountPesewas(workedMinutes: number, hourlyRatePesewas: number): number {
  const numerator = BigInt(Math.round(workedMinutes)) * BigInt(Math.round(hourlyRatePesewas));
  const denominator = 60n;
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/** Minutes as the two-decimal hours an invoice bills: 10350 → "172.50h". */
export function hoursForInvoice(minutes: number): string {
  return `${(minutes / 60).toFixed(2)}h`;
}

/** An amount with the currency code a PDF can actually carry (see the file header). */
export function moneyWithCurrency(pesewas: number): string {
  return `GHS ${money(pesewas)}`;
}

/** The month as a person reads it: "2026-09" → "September 2026". */
export function monthForInvoice(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year as number, (monthNumber as number) - 1, 1)));
}

/** A label on the left and an amount right-aligned to the page's own margin. */
function amountRow(y: number, label: string, amount: string, bold = false): Line[] {
  const size = 10;
  return [
    { x: MARGIN, y, size, font: bold ? 'HB' : 'H', text: label },
    {
      x: RIGHT_EDGE - amount.length * COURIER_WIDTH * size,
      y,
      size,
      font: 'C',
      text: amount,
    },
  ];
}

/** One right-aligned Courier cell inside the table, such as an hours or a money column. */
function cell(x: number, y: number, size: number, text: string): Line {
  const width = text.length * COURIER_WIDTH * size;
  return { x: x - width, y, size, font: 'C', text };
}

/** Lays the invoice out and assembles it. */
export function buildSiteInvoicePdf(invoice: SiteInvoiceForPdf): BuiltPdf {
  const lines: Line[] = [];
  const rules: number[] = [];
  let y = PAGE_HEIGHT - MARGIN;
  const row = 13;

  lines.push({ x: MARGIN, y, size: 18, font: 'HB', text: invoice.issuerName });
  lines.push({ x: MARGIN + 220, y, size: 11, font: 'H', text: 'Invoice' });
  y -= 24;

  lines.push({
    x: MARGIN,
    y,
    size: 10,
    font: 'H',
    text: `${invoice.invoiceNumber}  ·  Issued ${invoice.issuedOn}`,
  });
  y -= 22;

  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: `Bill to: ${invoice.clientName}` });
  y -= 15;
  lines.push({
    x: MARGIN,
    y,
    size: 10,
    font: 'H',
    text: `${invoice.siteCode} · ${invoice.siteName}`,
  });
  y -= 14;
  lines.push({ x: MARGIN, y, size: 10, font: 'H', text: `For ${monthForInvoice(invoice.month)}` });
  y -= 22;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Hours billed at this site' });
  y -= 18;

  // The table header. Everything after it lines up with these same columns.
  lines.push({ x: NAME_X, y, size: 9, font: 'HB', text: 'Worker' });
  lines.push({ x: STAFF_X, y, size: 9, font: 'HB', text: 'Staff no.' });
  lines.push(cell(HOURS_RIGHT, y, 9, 'Hours'));
  lines.push(cell(RATE_RIGHT, y, 9, 'Rate GHS'));
  lines.push(cell(AMOUNT_RIGHT, y, 9, 'Amount GHS'));
  y -= 6;
  rules.push(y);
  y -= 13;

  // Billed from every line, whether or not it ends up printed below — an
  // invoice must bill for every hour worked, not only for as many rows as
  // fit on one page.
  let totalMinutes = 0;
  let subtotalPesewas = 0;
  for (const line of invoice.lines) {
    totalMinutes += line.workedMinutes;
    subtotalPesewas += lineAmountPesewas(line.workedMinutes, invoice.hourlyRatePesewas);
  }

  if (invoice.lines.length === 0) {
    lines.push({
      x: MARGIN,
      y,
      size: 9,
      font: 'H',
      text: 'No counted shifts were recorded at this site in this month.',
    });
    y -= row;
  }

  // Printed only as far as the page has room for, reserved below for the
  // totals and the closing note. A name may wrap to more than one line, so
  // this is judged by the space a row actually needs, not by a row count —
  // a fixed count would have let enough long names run the table off the
  // bottom of the page.
  let shownCount = 0;
  for (const line of invoice.lines) {
    const nameParts = wrapToWidth(line.fullName, 9, NAME_WIDTH);
    const neededHeight = nameParts.length * row;
    if (y - neededHeight < BOTTOM_RESERVED) {
      break;
    }

    const amountPesewas = lineAmountPesewas(line.workedMinutes, invoice.hourlyRatePesewas);
    lines.push({ x: NAME_X, y, size: 9, font: 'H', text: nameParts[0] ?? '' });
    lines.push({ x: STAFF_X, y, size: 9, font: 'C', text: line.staffNumber });
    lines.push(cell(HOURS_RIGHT, y, 9, hoursForInvoice(line.workedMinutes)));
    lines.push(cell(RATE_RIGHT, y, 9, money(invoice.hourlyRatePesewas)));
    lines.push(cell(AMOUNT_RIGHT, y, 9, money(amountPesewas)));
    y -= row;

    // A name too long for one line continues below, on its own — the
    // figures beside it belong to the first line only, where they were read.
    for (const extra of nameParts.slice(1)) {
      lines.push({ x: NAME_X, y, size: 9, font: 'H', text: extra });
      y -= row;
    }
    shownCount += 1;
  }

  const omitted = invoice.lines.length - shownCount;
  if (omitted > 0) {
    lines.push({
      x: MARGIN,
      y,
      size: 8,
      font: 'H',
      text: `and ${omitted} more worker${omitted === 1 ? '' : 's'}, in the attendance report for this site.`,
    });
    y -= row;
  }

  y -= 6;
  rules.push(y + 10);
  y -= 4;
  lines.push(...amountRow(y, 'Total hours', hoursForInvoice(totalMinutes)));
  y -= 16;
  lines.push(...amountRow(y, 'Subtotal', moneyWithCurrency(subtotalPesewas), true));
  y -= 24;

  lines.push({ x: MARGIN, y, size: 9, font: 'HB', text: 'Taxes are not included.' });

  return assemblePdf(lines, rules);
}

/** What the file is called when somebody saves it: `invoice-ACC-01-2026-09.pdf`. */
export function invoiceFileName(siteCode: string, month: string): string {
  return `invoice-${safeForAFileName(siteCode)}-${month}.pdf`;
}

/** Letters, digits, dashes and underscores. Everything else becomes a dash. */
function safeForAFileName(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9_-]/g, '-');
  return cleaned === '' ? 'unknown' : cleaned;
}
