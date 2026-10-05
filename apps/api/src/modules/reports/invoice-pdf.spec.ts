import { describe, expect, it } from 'vitest';
import {
  buildSiteInvoicePdf,
  hoursForInvoice,
  type InvoiceLineForPdf,
  invoiceFileName,
  lineAmountPesewas,
  moneyWithCurrency,
  monthForInvoice,
  type SiteInvoiceForPdf,
} from './invoice-pdf.js';

/** Two workers at one site, for a month, at GHS 15.00 an hour. */
const LINES: InvoiceLineForPdf[] = [
  { staffNumber: 'SMT-00042', fullName: 'Kwame Mensah', workedMinutes: 10_320 }, // 172.00h
  { staffNumber: 'SMT-00043', fullName: 'Ama Serwaa Boateng', workedMinutes: 9_900 }, // 165.00h
];

const INVOICE: SiteInvoiceForPdf = {
  issuerName: 'Golden Shield Security Ltd',
  clientName: 'Ridge Towers Management Ltd',
  siteCode: 'ACC-01',
  siteName: 'Ridge Towers Office Complex',
  month: '2026-09',
  invoiceNumber: 'INV-ACC-01-202609',
  issuedOn: '2026-10-01',
  hourlyRatePesewas: 1_500,
  lines: LINES,
};

/** The document as text, which is how these tests read it. */
const asText = (invoice: SiteInvoiceForPdf) =>
  Buffer.from(buildSiteInvoicePdf(invoice).bytes).toString('latin1');

/** Every piece of text the page draws, with where it was put. */
const placements = (invoice: SiteInvoiceForPdf) => {
  const text = asText(invoice);
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

/**
 * The omitted-rows summary, reconstructed from however many lines it was
 * wrapped to (size 8 is used nowhere else on the page). Rejoining with a
 * single space undoes `wrapToWidth`'s own word-wrap exactly, and undoing
 * `textForPdf`'s own escaping of `(`, `)` and `\` turns it back into the
 * plain sentence a reader sees, so a test can read it whole no matter where
 * it happened to break.
 */
const omittedSummary = (invoice: SiteInvoiceForPdf) =>
  placements(invoice)
    .filter((placement) => placement.size === 8)
    .sort((a, b) => b.y - a.y)
    .map((placement) => placement.body)
    .join(' ')
    .replaceAll(/\\([\\()])/g, '$1');

describe('billing minutes at a rate', () => {
  it('rounds half up, the same rule payroll rounds overtime pay by', () => {
    expect(lineAmountPesewas(60, 1_500)).toBe(1_500); // exactly one hour
    expect(lineAmountPesewas(90, 1_000)).toBe(1_500); // 1.5 hours, exact
    expect(lineAmountPesewas(7, 1_300)).toBe(152); // 151.66… rounds up
    expect(lineAmountPesewas(2, 915)).toBe(31); // a tie (30.5) rounds up too
    expect(lineAmountPesewas(0, 5_000)).toBe(0);
  });
});

describe('the numbers as a person reads them', () => {
  it('writes hours to two decimal places, with the unit beside them', () => {
    expect(hoursForInvoice(10_320)).toBe('172.00h');
    expect(hoursForInvoice(90)).toBe('1.50h');
    expect(hoursForInvoice(0)).toBe('0.00h');
  });

  it('writes money with the currency code a PDF can actually carry', () => {
    // The dashboard shows "GH₵ 5,055.00"; the cedi sign is outside Latin-1.
    expect(moneyWithCurrency(505_500)).toBe('GHS 5,055.00');
  });

  it('writes the month as a person says it', () => {
    expect(monthForInvoice('2026-09')).toBe('September 2026');
    expect(monthForInvoice('2026-01')).toBe('January 2026');
  });
});

describe('the invoice document', () => {
  it('is a PDF a reader will open: header, one page, and a trailer', () => {
    const text = asText(INVOICE);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('/MediaBox [0 0 595 842]');
  });

  it('embeds no font, because the three it uses are in every reader', () => {
    const text = asText(INVOICE);
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).toContain('/BaseFont /Courier');
    expect(text).not.toContain('/FontFile');
  });

  it('headers the issuer, the client, the site and the month', () => {
    const text = asText(INVOICE);
    expect(text).toContain('Golden Shield Security Ltd');
    expect(text).toContain('Invoice');
    expect(text).toContain('INV-ACC-01-202609');
    expect(text).toContain('Issued 2026-10-01');
    expect(text).toContain('Bill to: Ridge Towers Management Ltd');
    expect(text).toContain('ACC-01');
    expect(text).toContain('Ridge Towers Office Complex');
    expect(text).toContain('For September 2026');
  });

  it('lists every worker with their name, staff number, hours, rate and amount', () => {
    const text = asText(INVOICE);
    expect(text).toContain('Kwame Mensah');
    expect(text).toContain('SMT-00042');
    expect(text).toContain('172.00h');
    // 10,320 minutes at GHS 15.00 an hour is exactly GHS 2,580.00.
    expect(text).toContain('2,580.00');
    expect(text).toContain('Ama Serwaa Boateng');
    expect(text).toContain('SMT-00043');
    expect(text).toContain('165.00h');
    // 9,900 minutes at GHS 15.00 an hour is exactly GHS 2,475.00.
    expect(text).toContain('2,475.00');
    // The rate is printed beside every row, so each amount can be checked by hand.
    expect(text.match(/15\.00/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('totals the hours and the subtotal from the printed rows, not a separate sum', () => {
    const text = asText(INVOICE);
    // 172.00h + 165.00h.
    expect(text).toContain('337.00h');
    // GHS 2,580.00 + GHS 2,475.00.
    expect(text).toContain('GHS 5,055.00');
  });

  it('says plainly that it does not include tax', () => {
    expect(asText(INVOICE)).toContain('Taxes are not included.');
  });

  it('says so when nothing was counted, rather than printing an empty table', () => {
    const text = asText({ ...INVOICE, lines: [] });
    expect(text).toContain('No counted shifts were recorded at this site in this month.');
    expect(text).toContain('0.00h');
    expect(text).toContain('GHS 0.00');
  });

  it('still bills every hour when there are more workers than fit on one page, and the summary line itself adds up', () => {
    // Long enough names that not every one of the 50 fits on the page.
    const many: InvoiceLineForPdf[] = Array.from({ length: 50 }, (_, index) => ({
      staffNumber: `SMT-${String(index + 1).padStart(5, '0')}`,
      fullName: `Nana Worker Number ${index + 1} Mensah-Boateng`,
      workedMinutes: 60,
    }));
    const invoice = { ...INVOICE, lines: many };
    const text = asText(invoice);

    // The grand total always covers all 50 workers' hours and amount, however
    // many rows are printed.
    expect(text).toContain(hoursForInvoice(50 * 60));
    expect(text).toContain(
      moneyWithCurrency(lineAmountPesewas(60, INVOICE.hourlyRatePesewas) * 50),
    );

    const summary = /and (\d+) more workers? \(([\d.]+h), (GHS [\d,.]+)\)/.exec(
      omittedSummary(invoice),
    );
    expect(summary).not.toBeNull();
    const omittedCount = Number(summary?.[1]);
    expect(omittedCount).toBeGreaterThan(0);
    expect(omittedCount).toBeLessThan(50);

    // The summary line's own hours and amount are exactly the rows it left
    // out — neither more (double-counted) nor less (quietly dropped) than
    // what the visible rows plus this one line need to reach the total above.
    expect(summary?.[2]).toBe(hoursForInvoice(omittedCount * 60));
    expect(summary?.[3]).toBe(
      moneyWithCurrency(lineAmountPesewas(60, INVOICE.hourlyRatePesewas) * omittedCount),
    );

    // And that count is exactly the workers not among the printed rows.
    const shownStaffNumbers = new Set(text.match(/SMT-\d{5}/g));
    expect(shownStaffNumbers.size).toBe(50 - omittedCount);
  });

  it('cannot be made to inject a drawing operator through a name', () => {
    const text = asText({
      ...INVOICE,
      lines: [
        { ...LINES[0], fullName: 'Ghost) Tj ET 0 0 1 rg BT (Owed 99999' } as InvoiceLineForPdf,
      ],
    });
    expect(text).toContain('Ghost\\) Tj ET');
    expect(text).not.toContain('Ghost) Tj ET');
  });
});

describe('the layout stays on the page', () => {
  const MANY_LONG_NAMES: InvoiceLineForPdf[] = Array.from({ length: 50 }, (_, index) => ({
    staffNumber: `SMT-${String(index + 1).padStart(5, '0')}`,
    fullName: 'Nana Adwoa Serwaa Yeboah-Asantewaa Boateng Mensah',
    workedMinutes: 12_345,
  }));

  it('puts every line inside the page, on both axes, even with many long names', () => {
    for (const placement of placements({ ...INVOICE, lines: MANY_LONG_NAMES })) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeLessThanOrEqual(842);
      expect(placement.x).toBeLessThan(595 - 56);
    }
  });

  it('never runs off the bottom, even with a full page of rows', () => {
    const lowest = Math.min(...placements({ ...INVOICE, lines: MANY_LONG_NAMES }).map((p) => p.y));
    expect(lowest).toBeGreaterThan(0);
  });

  it('never lets a Courier cell cross the page margin on the right', () => {
    const amounts = placements({ ...INVOICE, lines: MANY_LONG_NAMES }).filter(
      (placement) => placement.font === 'C',
    );
    expect(amounts.length).toBeGreaterThan(5);
    for (const amount of amounts) {
      const right = amount.x + amount.body.length * 0.6 * amount.size;
      expect(right).toBeLessThanOrEqual(595 - 56 + 0.01);
    }
  });

  it('right-aligns each column to its own edge, so the rate sits above the amount it feeds', () => {
    const cellsByText = new Map(placements(INVOICE).map((p) => [p.body, p]));
    const rightEdgeOf = (body: string) => {
      const cell = cellsByText.get(body);
      if (!cell) throw new Error(`No cell with text "${body}" was drawn.`);
      return cell.x + cell.body.length * 0.6 * cell.size;
    };
    // The header and the first worker's row both line up on the same edges.
    expect(rightEdgeOf('Hours')).toBeCloseTo(rightEdgeOf('172.00h'), 1);
    expect(rightEdgeOf('Rate GHS')).toBeCloseTo(rightEdgeOf('15.00'), 1);
    expect(rightEdgeOf('Amount GHS')).toBeCloseTo(rightEdgeOf('2,580.00'), 1);
    // The subtotal, printed outside the table, lands on the page's own margin.
    expect(rightEdgeOf('GHS 5,055.00')).toBeCloseTo(595 - 56, 1);
  });
});

describe('what the file is called when somebody saves it', () => {
  it('names the site and the month', () => {
    expect(invoiceFileName('ACC-01', '2026-09')).toBe('invoice-ACC-01-2026-09.pdf');
  });
});
