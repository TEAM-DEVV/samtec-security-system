import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  basisPointsAsPercent,
  buildPayslipPdf,
  hoursAndMinutes,
  money,
  type PayslipForPdf,
  payslipFileName,
  textForPdf,
} from './payslip-pdf.js';

/**
 * Golden payslip 3 from the design page, as a document: basic GHS 1,200 for a
 * whole month plus forty hours of overtime at GHS 8.00.
 */
const PAYSLIP: PayslipForPdf = {
  staffNumber: 'SMT-00042',
  fullName: 'Kwame Mensah',
  periodStartDate: '2026-09-01',
  periodEndDate: '2026-09-30',
  daysInPeriod: 30,
  daysEmployed: 30,
  basicMonthlyPesewas: 120_000,
  basicPesewas: 120_000,
  overtimeHourlyPesewas: 800,
  overtimeMinutes: 2_400,
  overtimePesewas: 32_000,
  taxableAllowancePesewas: 0,
  nonTaxableAllowancePesewas: 0,
  grossPesewas: 152_000,
  taxableGrossPesewas: 152_000,
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployeePesewas: 6_600,
  ssnitEmployerBasisPoints: 1300,
  ssnitEmployerPesewas: 15_600,
  chargeableIncomePesewas: 145_400,
  payePesewas: 11_870,
  otherDeductionsPesewas: 0,
  netPayPesewas: 133_530,
  taxYear: 2026,
  adjustmentNote: null,
};

/** The document as text, which is how these tests read it. */
const asText = (payslip: PayslipForPdf) =>
  Buffer.from(buildPayslipPdf(payslip).bytes).toString('latin1');

describe('the numbers as a person reads them', () => {
  it('writes cedis with two decimal places and thousands grouped', () => {
    expect(money(133_530)).toBe('1,335.30');
    expect(money(100)).toBe('1.00');
    expect(money(5)).toBe('0.05');
    expect(money(0)).toBe('0.00');
    expect(money(123_456_789)).toBe('1,234,567.89');
  });

  it('writes a correction that takes money back with a minus in front', () => {
    expect(money(-15_275)).toBe('-152.75');
  });

  it('writes minutes as hours a person would say out loud', () => {
    expect(hoursAndMinutes(2_400)).toBe('40h');
    expect(hoursAndMinutes(0)).toBe('0h');
    expect(hoursAndMinutes(95)).toBe('1h 35m');
    expect(hoursAndMinutes(605)).toBe('10h 05m');
  });

  it('writes a rate as the percentage it is', () => {
    expect(basisPointsAsPercent(550)).toBe('5.5%');
    expect(basisPointsAsPercent(1300)).toBe('13%');
    expect(basisPointsAsPercent(1350)).toBe('13.5%');
    expect(basisPointsAsPercent(0)).toBe('0%');
    expect(basisPointsAsPercent(1750)).toBe('17.5%');
  });
});

describe('text a PDF can carry', () => {
  it('escapes the three characters that would end the string early', () => {
    // An unescaped bracket would truncate the page and could inject an operator.
    expect(textForPdf('Kwame (KK) Mensah')).toBe('Kwame \\(KK\\) Mensah');
    expect(textForPdf('back\\slash')).toBe('back\\\\slash');
  });

  it('keeps an accented Latin name, which WinAnsi covers', () => {
    expect(textForPdf('Adjoa Yeboah-Asékoun')).toBe('Adjoa Yeboah-Asékoun');
  });

  it('replaces anything outside Latin-1 rather than writing a broken glyph', () => {
    // A reader can see that a name has been simplified. A broken glyph just
    // looks like the system is wrong about who they are.
    expect(textForPdf('Ama 中文')).toBe('Ama ??');
  });
});

describe('the payslip document', () => {
  it('is a PDF a reader will open: header, one page, and a trailer', () => {
    const text = asText(PAYSLIP);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('/MediaBox [0 0 595 842]');
    expect(text).toContain('startxref');
  });

  it('points the cross-reference table at the real byte each object starts at', () => {
    // This is the one part of the format that is easy to get wrong and that
    // makes a reader refuse the file outright.
    const text = asText(PAYSLIP);
    const table = text.slice(text.indexOf('xref\n'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(7);
    for (const [index, offset] of offsets.entries()) {
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    }
    const startxref = Number(
      text
        .slice(text.lastIndexOf('startxref\n') + 10)
        .trim()
        .split('\n')[0],
    );
    expect(text.slice(startxref).startsWith('xref\n')).toBe(true);
  });

  it('declares the exact byte length of the drawing it contains', () => {
    const text = asText(PAYSLIP);
    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const stream = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    expect(Buffer.from(stream, 'latin1').byteLength).toBe(declared);
  });

  it('embeds no font, because the three it uses are in every reader', () => {
    const text = asText(PAYSLIP);
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).toContain('/BaseFont /Courier');
    // Nothing embedded means no font file, and no font-parsing dependency.
    expect(text).not.toContain('/FontFile');
  });

  it('prints every figure a worker would check, and the rate beside each one', () => {
    const text = asText(PAYSLIP);
    expect(text).toContain('SMT-00042');
    expect(text).toContain('Kwame Mensah');
    expect(text).toContain('2026-09-01');
    expect(text).toContain('2026-09-30');
    // Earnings and what they came from.
    expect(text).toContain('1,200.00');
    expect(text).toContain('40h at 8.00 an hour');
    expect(text).toContain('320.00');
    expect(text).toContain('1,520.00');
    // Taken off, each with its rate.
    expect(text).toContain('5.5% of basic');
    expect(text).toContain('66.00');
    expect(text).toContain('118.70');
    // What is left.
    expect(text).toContain('NET PAY');
    expect(text).toContain('1,335.30');
    // And the company's own share, which is not taken from the worker.
    expect(text).toContain('13% of basic');
    expect(text).toContain('156.00');
  });

  it('leaves out a row that is nothing, so the page is not padded with zeros', () => {
    const text = asText(PAYSLIP);
    expect(text).not.toContain('Allowance');
    expect(text).not.toContain('Other deductions');
  });

  it('prints an allowance and a deduction when there is one', () => {
    const text = asText({
      ...PAYSLIP,
      taxableAllowancePesewas: 15_000,
      nonTaxableAllowancePesewas: 5_000,
      otherDeductionsPesewas: 2_000,
    });
    expect(text).toContain('Allowance  \\(taxed\\)');
    expect(text).toContain('Allowance  \\(not taxed\\)');
    expect(text).toContain('Other deductions');
  });

  it('says on its face when it is a correction and not a month of pay', () => {
    const text = asText({ ...PAYSLIP, adjustmentNote: 'Days employed corrected after approval.' });
    expect(text).toContain('This is a correction to an earlier month');
  });

  it('reports its own size and fingerprint, which the payslip row records', () => {
    const built = buildPayslipPdf(PAYSLIP);
    expect(built.sizeBytes).toBe(built.bytes.byteLength);
    expect(built.sizeBytes).toBeGreaterThan(1_000);
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.sha256).toBe(createHash('sha256').update(built.bytes).digest('hex'));
  });

  it('builds the same bytes twice, so the fingerprint means something', () => {
    // A payslip is stored once and never regenerated, but a fingerprint that
    // changed on every build could not prove the stored file was untouched.
    expect(buildPayslipPdf(PAYSLIP).sha256).toBe(buildPayslipPdf(PAYSLIP).sha256);
  });

  it('cannot be made to inject a drawing operator through a name', () => {
    const text = asText({ ...PAYSLIP, fullName: 'Ghost) Tj ET 0 0 1 rg BT (Owed 99999' });
    // The brackets are escaped, so the whole thing stays one piece of text.
    expect(text).toContain('Ghost\\) Tj ET');
    expect(text).not.toContain('Ghost) Tj ET');
  });
});

describe('the layout stays on the page', () => {
  /** Every piece of text the page draws, with where it was put. */
  const placements = (payslip: PayslipForPdf) => {
    const text = Buffer.from(buildPayslipPdf(payslip).bytes).toString('latin1');
    const stream = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    return [
      ...stream.matchAll(/BT \/(\w+) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \((.*)\) Tj ET/g),
    ].map((match) => ({
      font: match[1] as string,
      size: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
      body: match[5] as string,
    }));
  };

  /** The fullest payslip: every optional row present, and long values. */
  const FULL: PayslipForPdf = {
    ...PAYSLIP,
    fullName: 'Nana Adwoa Serwaa Yeboah-Asantewaa',
    basicMonthlyPesewas: 99_999_999,
    basicPesewas: 99_999_999,
    overtimeHourlyPesewas: 99_999,
    overtimeMinutes: 9_999,
    overtimePesewas: 16_665_000,
    taxableAllowancePesewas: 15_000,
    nonTaxableAllowancePesewas: 5_000,
    grossPesewas: 116_684_999,
    otherDeductionsPesewas: 2_000,
    netPayPesewas: 100_000_000,
    adjustmentNote: 'Days employed corrected after approval.',
  };

  it('puts every line inside the page, on both axes', () => {
    for (const placement of placements(FULL)) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeLessThanOrEqual(842);
      // Nothing starts past the right margin, even the widest amount.
      expect(placement.x).toBeLessThan(595 - 56);
    }
  });

  it('never runs off the bottom, even with every optional row and a long name', () => {
    const lowest = Math.min(...placements(FULL).map((placement) => placement.y));
    // Comfortably above the bottom edge, so a reader loses nothing.
    expect(lowest).toBeGreaterThan(30);
  });

  it('right-aligns the money column to one edge', () => {
    const amounts = placements(FULL).filter((placement) => placement.font === 'C');
    expect(amounts.length).toBeGreaterThan(5);
    for (const amount of amounts) {
      // Courier is 0.6 em per character, so the right edge is exact.
      const right = amount.x + amount.body.length * 0.6 * amount.size;
      expect(right).toBeCloseTo(595 - 56, 1);
    }
  });

  it('draws from the top down, so nothing sits on top of anything else', () => {
    const ys = placements(PAYSLIP).map((placement) => placement.y);
    // Each row is either below the last or on the same line as it (a label and
    // its amount share a line).
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index]).toBeLessThanOrEqual(ys[index - 1] as number);
    }
  });
});

describe('what the file is called when somebody saves it', () => {
  it('names the worker and the month', () => {
    expect(payslipFileName('SMT-00042', '2026-09-30', 'a1b2c3d4-0000', false)).toBe(
      'payslip-SMT-00042-2026-09.pdf',
    );
  });

  it('marks a correction, because one month can have two payslips', () => {
    expect(payslipFileName('SMT-00042', '2026-09-30', 'a1b2c3d4-0000', true)).toBe(
      'payslip-SMT-00042-2026-09-adjustment-a1b2c3d4.pdf',
    );
  });
});
