/**
 * A payslip, as a one-page PDF, written directly.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md. There is no PDF library here on
 * purpose, the same reasoning that put the two-factor code generator in this
 * codebase by hand rather than as a dependency:
 *
 * - A payslip is one page of text in a standard font. PDF is a text format, and
 *   the fourteen standard fonts are built into every reader, so nothing has to
 *   be embedded, measured or subset. That is the whole reason this is short.
 * - The library the plan first named has no published proof of who built it, on
 *   any version, and nor do its six dependencies. It would also add about ten
 *   megabytes to a serverless function. For an output this small, that is a lot
 *   of trust to buy for very little.
 * - Every figure on a payslip is money somebody will dispute one day, so being
 *   able to read the whole generator in one sitting is worth something.
 *
 * Two deliberate choices make the layout arithmetic trivial:
 *
 * - **Helvetica for words, Courier for money.** Courier is monospaced, so a
 *   column of amounts right-aligns exactly by counting characters. No font
 *   metrics table, no measuring.
 * - **WinAnsi encoding**, which covers Latin-1. Ghanaian names are Latin, but
 *   anything outside that set is replaced rather than written as a broken glyph,
 *   and `nameForPdf` is the one place that happens.
 */
import { createHash } from 'node:crypto';

/** A4 in PDF points, and a margin of about two centimetres. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
/** Courier is exactly 600 thousandths of an em wide per character. */
const COURIER_WIDTH = 0.6;

/** Everything printed on a payslip. Only what the reader can see. */
export interface PayslipForPdf {
  staffNumber: string;
  fullName: string;
  periodStartDate: string;
  periodEndDate: string;
  daysInPeriod: number;
  daysEmployed: number;
  basicMonthlyPesewas: number;
  basicPesewas: number;
  overtimeHourlyPesewas: number;
  overtimeMinutes: number;
  overtimePesewas: number;
  taxableAllowancePesewas: number;
  nonTaxableAllowancePesewas: number;
  grossPesewas: number;
  taxableGrossPesewas: number;
  ssnitEmployeeBasisPoints: number;
  ssnitEmployeePesewas: number;
  ssnitEmployerBasisPoints: number;
  ssnitEmployerPesewas: number;
  chargeableIncomePesewas: number;
  payePesewas: number;
  otherDeductionsPesewas: number;
  netPayPesewas: number;
  taxYear: number;
  /** Set on a correction to an earlier month, and printed as such. */
  adjustmentNote: string | null;
}

/** The finished document, with what the payslip row has to record about it. */
export interface BuiltPdf {
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
}

/** Pesewas as cedis, always two decimal places, grouped in thousands. */
export function money(pesewas: number): string {
  const negative = pesewas < 0;
  const size = Math.abs(pesewas);
  const cedis = Math.trunc(size / 100).toString();
  const pesewa = String(size % 100).padStart(2, '0');
  const grouped = cedis.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${pesewa}`;
}

/** Minutes as the hours and minutes a person would read. */
export function hoursAndMinutes(minutes: number): string {
  const whole = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${whole}h` : `${whole}h ${String(rest).padStart(2, '0')}m`;
}

/**
 * Text a PDF can carry, in WinAnsi.
 *
 * Brackets and backslashes end or escape a PDF string, so they are escaped.
 * Anything outside Latin-1 becomes a question mark: a name with a broken glyph
 * in it is worse than a name a reader can see has been simplified, and this is
 * the only place in the system where that can happen.
 */
export function textForPdf(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 63;
    if (character === '\\' || character === '(' || character === ')') {
      out += `\\${character}`;
    } else if (code >= 32 && code <= 255) {
      out += character;
    } else {
      out += '?';
    }
  }
  return out;
}

/** One line of text at a position, in a named font. */
interface Line {
  x: number;
  y: number;
  size: number;
  font: 'H' | 'HB' | 'C';
  text: string;
}

/** A label on the left and an amount right-aligned to the same edge. */
function amountRow(
  y: number,
  label: string,
  amount: string,
  options: { bold?: boolean } = {},
): Line[] {
  const size = 10;
  const right = PAGE_WIDTH - MARGIN;
  // Courier is monospaced, so the width is just the character count.
  const width = amount.length * COURIER_WIDTH * size;
  return [
    { x: MARGIN, y, size, font: options.bold ? 'HB' : 'H', text: label },
    { x: right - width, y, size, font: 'C', text: amount },
  ];
}

/** A rule across the page, drawn as a very thin filled rectangle. */
function rule(y: number): string {
  return `${MARGIN} ${y} ${PAGE_WIDTH - 2 * MARGIN} 0.6 re f`;
}

/**
 * Lays the payslip out.
 *
 * The order is the order the money moves: what was earned, what was taken off,
 * what is left. Every figure is printed beside the figures it came from, so the
 * whole page can be checked with a calculator — which is decision 24's whole
 * point, and the reason a worker can argue with it.
 */
function layout(payslip: PayslipForPdf): { lines: Line[]; rules: number[] } {
  const lines: Line[] = [];
  const rules: number[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  lines.push({ x: MARGIN, y, size: 18, font: 'HB', text: 'SAMTEC' });
  lines.push({ x: MARGIN + 90, y, size: 11, font: 'H', text: 'Payslip' });
  y -= 28;

  lines.push({
    x: MARGIN,
    y,
    size: 11,
    font: 'HB',
    text: `${payslip.fullName}  (${payslip.staffNumber})`,
  });
  y -= 16;
  lines.push({
    x: MARGIN,
    y,
    size: 10,
    font: 'H',
    text: `For ${payslip.periodStartDate} to ${payslip.periodEndDate}`,
  });
  y -= 14;
  lines.push({
    x: MARGIN,
    y,
    size: 9,
    font: 'H',
    text: `Days employed in the period: ${payslip.daysEmployed} of ${payslip.daysInPeriod}`,
  });

  if (payslip.adjustmentNote !== null) {
    y -= 14;
    lines.push({
      x: MARGIN,
      y,
      size: 9,
      font: 'HB',
      text: 'This is a correction to an earlier month, not a full month of pay.',
    });
  }

  y -= 22;
  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Earnings' });
  y -= 18;

  lines.push(
    ...amountRow(
      y,
      `Basic  (${money(payslip.basicMonthlyPesewas)} a month, ${payslip.daysEmployed}/${payslip.daysInPeriod} days)`,
      money(payslip.basicPesewas),
    ),
  );
  y -= 15;

  if (payslip.overtimeMinutes !== 0 || payslip.overtimePesewas !== 0) {
    lines.push(
      ...amountRow(
        y,
        `Overtime  (${hoursAndMinutes(payslip.overtimeMinutes)} at ${money(payslip.overtimeHourlyPesewas)} an hour)`,
        money(payslip.overtimePesewas),
      ),
    );
    y -= 15;
  }
  if (payslip.taxableAllowancePesewas !== 0) {
    lines.push(...amountRow(y, 'Allowance  (taxed)', money(payslip.taxableAllowancePesewas)));
    y -= 15;
  }
  if (payslip.nonTaxableAllowancePesewas !== 0) {
    lines.push(
      ...amountRow(y, 'Allowance  (not taxed)', money(payslip.nonTaxableAllowancePesewas)),
    );
    y -= 15;
  }

  rules.push(y + 10);
  y -= 4;
  lines.push(...amountRow(y, 'Gross pay', money(payslip.grossPesewas), { bold: true }));
  y -= 26;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Taken off' });
  y -= 18;

  lines.push(
    ...amountRow(
      y,
      `SSNIT, your share  (${basisPointsAsPercent(payslip.ssnitEmployeeBasisPoints)} of basic)`,
      money(payslip.ssnitEmployeePesewas),
    ),
  );
  y -= 15;
  lines.push(
    ...amountRow(
      y,
      `Income tax  (PAYE ${payslip.taxYear}, on ${money(payslip.chargeableIncomePesewas)})`,
      money(payslip.payePesewas),
    ),
  );
  y -= 15;
  if (payslip.otherDeductionsPesewas !== 0) {
    lines.push(...amountRow(y, 'Other deductions', money(payslip.otherDeductionsPesewas)));
    y -= 15;
  }

  rules.push(y + 10);
  y -= 6;
  lines.push(...amountRow(y, 'NET PAY', money(payslip.netPayPesewas), { bold: true }));
  y -= 30;

  rules.push(y + 10);
  lines.push({
    x: MARGIN,
    y,
    size: 9,
    font: 'HB',
    text: 'Paid for you by the company, not taken from your pay',
  });
  y -= 14;
  lines.push(
    ...amountRow(
      y,
      `SSNIT, the company's share  (${basisPointsAsPercent(payslip.ssnitEmployerBasisPoints)} of basic)`,
      money(payslip.ssnitEmployerPesewas),
    ),
  );
  y -= 30;

  lines.push({
    x: MARGIN,
    y,
    size: 8,
    font: 'H',
    text: 'Every figure above is worked out from the figures printed beside it, so this page can be',
  });
  y -= 11;
  lines.push({
    x: MARGIN,
    y,
    size: 8,
    font: 'H',
    text: 'checked with a calculator. Gross pay is the earnings added up. Net pay is gross pay less',
  });
  y -= 11;
  lines.push({
    x: MARGIN,
    y,
    size: 8,
    font: 'H',
    text: 'everything taken off. If a figure looks wrong, ask the payroll office and quote your staff',
  });
  y -= 11;
  lines.push({ x: MARGIN, y, size: 8, font: 'H', text: 'number and the dates above.' });

  return { lines, rules };
}

/** Basis points as the percentage a person reads: 550 becomes 5.5%. */
export function basisPointsAsPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = basisPoints % 100;
  if (fraction === 0) {
    return `${whole}%`;
  }
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

/**
 * Builds the file.
 *
 * A PDF is a handful of numbered objects, then a table saying which byte each
 * one starts at. Everything is assembled as Latin-1, so one character is one
 * byte and those offsets are simply string positions — which is the only fiddly
 * part of the format and the reason the encoding is fixed rather than chosen.
 */
export function buildPayslipPdf(payslip: PayslipForPdf): BuiltPdf {
  const { lines, rules } = layout(payslip);

  const drawing = [
    ...rules.map(rule),
    ...lines.map(
      (line) =>
        `BT /${line.font} ${line.size} Tf 1 0 0 1 ${line.x.toFixed(2)} ${line.y.toFixed(2)} Tm (${textForPdf(line.text)}) Tj ET`,
    ),
  ].join('\n');

  // One of the fourteen fonts every PDF reader already has, so nothing is
  // embedded. WinAnsi covers Latin-1, which is what `textForPdf` writes.
  const font = (base: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R ` +
      '/Resources << /Font << /H 5 0 R /HB 6 0 R /C 7 0 R >> >> >>',
    `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    font('Helvetica'),
    font('Helvetica-Bold'),
    font('Courier'),
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  const bytes = Buffer.from(pdf, 'latin1');
  return {
    bytes: new Uint8Array(bytes),
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * What a payslip file is called when somebody saves it.
 *
 * A worker can hold two payslips for one month — the month itself and a
 * correction to it — so an adjustment says so in the name and carries enough of
 * its id to tell two corrections apart.
 */
export function payslipFileName(
  staffNumber: string,
  periodEndDate: string,
  payslipId: string,
  isAdjustment: boolean,
): string {
  const month = periodEndDate.slice(0, 7);
  const suffix = isAdjustment ? `-adjustment-${payslipId.slice(0, 8)}` : '';
  return `payslip-${staffNumber}-${month}${suffix}.pdf`;
}
