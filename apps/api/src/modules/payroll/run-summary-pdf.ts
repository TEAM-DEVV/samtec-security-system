/**
 * A one-page summary of a payroll run, as a PDF.
 *
 * Design: docs/plan/07-roadmap.md, Phase 6. The page a payroll officer prints
 * and files: what the month cost, what is owed to SSNIT and to the GRA at the
 * rates the run used, how many people were paid, and who was left out.
 *
 * **It names no individual's pay.** That is what a payslip is for. This can
 * therefore be filed, emailed or shown in a meeting without handling anybody's
 * salary, which is the whole reason it exists as a separate document.
 *
 * It reuses the page assembler in `payslip-pdf.ts`, so there is one
 * implementation of the PDF format in this codebase and not two.
 */
import {
  assemblePdf,
  type BuiltPdf,
  basisPointsAsPercent,
  type Line,
  money,
  wrapToWidth,
} from './payslip-pdf.js';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const COURIER_WIDTH = 0.6;

/** Everything printed on the summary. */
export interface RunSummaryForPdf {
  periodStartDate: string;
  periodEndDate: string;
  status: string;
  employeeCount: number;
  lineCount: number;
  grossPesewas: number;
  ssnitEmployeePesewas: number;
  payePesewas: number;
  otherDeductionsPesewas: number;
  netPayPesewas: number;
  ssnitEmployerPesewas: number;
  ssnitEmployeeBasisPoints: number;
  ssnitEmployerBasisPoints: number;
  taxYear: number;
  approvedAt: string | null;
  paidOn: string | null;
  excluded: readonly { staffNumber: string; fullName: string; reason: string }[];
}

/** A label on the left and an amount right-aligned to the page's edge. */
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

/** Lays the summary out and assembles it. */
export function buildRunSummaryPdf(run: RunSummaryForPdf): BuiltPdf {
  const lines: Line[] = [];
  const rules: number[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  lines.push({ x: MARGIN, y, size: 18, font: 'HB', text: 'SAMTEC' });
  lines.push({ x: MARGIN + 90, y, size: 11, font: 'H', text: 'Payroll summary' });
  y -= 28;

  lines.push({
    x: MARGIN,
    y,
    size: 11,
    font: 'HB',
    text: `${run.periodStartDate} to ${run.periodEndDate}`,
  });
  y -= 16;
  lines.push({
    x: MARGIN,
    y,
    size: 9,
    font: 'H',
    text:
      `${run.employeeCount} paid across ${run.lineCount} line${run.lineCount === 1 ? '' : 's'}` +
      `${run.approvedAt === null ? '' : `  ·  approved ${run.approvedAt.slice(0, 10)}`}` +
      `${run.paidOn === null ? '' : `  ·  paid ${run.paidOn}`}`,
  });

  y -= 24;
  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'What the month cost' });
  y -= 18;

  lines.push(...amountRow(y, 'Gross pay', money(run.grossPesewas)));
  y -= 15;
  lines.push(
    ...amountRow(
      y,
      `SSNIT taken from workers  (${basisPointsAsPercent(run.ssnitEmployeeBasisPoints)} of basic)`,
      money(run.ssnitEmployeePesewas),
    ),
  );
  y -= 15;
  lines.push(...amountRow(y, `Income tax  (PAYE ${run.taxYear})`, money(run.payePesewas)));
  y -= 15;
  if (run.otherDeductionsPesewas !== 0) {
    lines.push(...amountRow(y, 'Other deductions', money(run.otherDeductionsPesewas)));
    y -= 15;
  }
  rules.push(y + 10);
  y -= 4;
  lines.push(...amountRow(y, 'Paid to workers', money(run.netPayPesewas), true));
  y -= 26;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'What the company owes on top' });
  y -= 18;
  lines.push(
    ...amountRow(
      y,
      `SSNIT, the company's share  (${basisPointsAsPercent(run.ssnitEmployerBasisPoints)} of basic)`,
      money(run.ssnitEmployerPesewas),
    ),
  );
  y -= 15;
  const owedToTheState = run.ssnitEmployeePesewas + run.ssnitEmployerPesewas + run.payePesewas;
  rules.push(y + 10);
  y -= 4;
  lines.push(...amountRow(y, 'Owed to the state', money(owedToTheState), true));
  y -= 15;
  lines.push(
    ...amountRow(
      y,
      'Total cost of the month',
      money(run.grossPesewas + run.ssnitEmployerPesewas),
      true,
    ),
  );
  y -= 28;

  rules.push(y + 8);
  lines.push({ x: MARGIN, y, size: 11, font: 'HB', text: 'Left out of this run' });
  y -= 16;
  if (run.excluded.length === 0) {
    lines.push({
      x: MARGIN,
      y,
      size: 9,
      font: 'H',
      text: 'Nobody. Every worker on the books was paid.',
    });
    y -= 14;
  } else {
    for (const left of run.excluded.slice(0, 20)) {
      // Wrapped, not cut: a long name used to push the reason off the page, and
      // the reason is the only part of this line that explains anything.
      for (const part of wrapToWidth(
        `${left.staffNumber}  ${left.fullName}  —  ${left.reason}`,
        9,
      )) {
        lines.push({ x: MARGIN, y, size: 9, font: 'H', text: part });
        y -= 13;
      }
    }
    if (run.excluded.length > 20) {
      lines.push({
        x: MARGIN,
        y,
        size: 9,
        font: 'H',
        text: `and ${run.excluded.length - 20} more, listed on the run's own page.`,
      });
      y -= 13;
    }
  }

  y -= 16;
  lines.push({
    x: MARGIN,
    y,
    size: 8,
    font: 'H',
    text: 'No individual\u2019s pay appears on this page. A worker\u2019s own figures are on their payslip.',
  });

  return assemblePdf(lines, rules);
}

/** What the file is called when somebody saves it. */
export function runSummaryFileName(periodEndDate: string): string {
  return `payroll-summary-${periodEndDate.slice(0, 7)}.pdf`;
}
