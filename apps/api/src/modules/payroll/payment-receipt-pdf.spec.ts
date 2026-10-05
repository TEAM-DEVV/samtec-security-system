import { describe, expect, it } from 'vitest';
import {
  buildPaymentReceiptPdf,
  destinationFor,
  type PaymentReceiptForPdf,
  type PaymentReceiptWorkerInput,
  paymentReceiptFileName,
} from './payment-receipt-pdf.js';
import { money } from './payslip-pdf.js';

const WORKERS: PaymentReceiptWorkerInput[] = [
  {
    staffNumber: 'SMT-00042',
    fullName: 'Kwame Mensah',
    netPayPesewas: 133_530,
    accountNumber: '1234567890123',
    momoNumber: null,
  },
  {
    staffNumber: 'SMT-00043',
    fullName: 'Ama Boateng',
    netPayPesewas: 96_320,
    accountNumber: null,
    momoNumber: '+233241234567',
  },
  {
    staffNumber: 'SMT-00044',
    fullName: 'Kojo Addo',
    netPayPesewas: 50_000,
    accountNumber: null,
    momoNumber: null,
  },
];

const RECEIPT: PaymentReceiptForPdf = {
  companyName: 'Alpha Shield Security Ltd',
  periodStartDate: '2026-08-01',
  periodEndDate: '2026-08-31',
  paidOn: '2026-08-28',
  paymentReference: 'GCB-TRF-2026-08-0031',
  payingBankName: 'Akwaaba Bank',
  payingBranch: 'Ridge',
  payingAccountNumberMasked: '**** 0123',
  workers: WORKERS,
};

const asText = (receipt: PaymentReceiptForPdf) =>
  Buffer.from(buildPaymentReceiptPdf(receipt).bytes).toString('latin1');

describe('a worker destination, masked', () => {
  it('shows a bank account masked to its last four digits', () => {
    expect(destinationFor(WORKERS[0] as PaymentReceiptWorkerInput)).toBe('**** 0123');
  });

  it('names mobile money by its last four digits when there is no bank account', () => {
    expect(destinationFor(WORKERS[1] as PaymentReceiptWorkerInput)).toBe(
      'mobile money ending 4567',
    );
  });

  it('says plainly when nobody has set up a destination at all', () => {
    expect(destinationFor(WORKERS[2] as PaymentReceiptWorkerInput)).toBe(
      'no payment details on file',
    );
  });

  it('prefers the bank account when both are on file', () => {
    expect(
      destinationFor({
        staffNumber: 'SMT-00001',
        fullName: 'Has Both',
        netPayPesewas: 1,
        accountNumber: '1234567890123',
        momoNumber: '+233241234567',
      }),
    ).toBe('**** 0123');
  });
});

describe('the payment receipt document', () => {
  it('is still a complete receipt when the run paid nobody', () => {
    const text = asText({ ...RECEIPT, workers: [] });
    expect(text).toContain('Total workers paid');
    expect(text).toContain('(0)');
    expect(text).toContain(money(0));
    expect(text).not.toContain('more, listed in full');
    expect(text).toContain('Akwaaba Bank, Ridge, account **** 0123');
  });

  it('is a PDF a reader will open: header, one page, and a trailer', () => {
    const text = asText(RECEIPT);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).not.toContain('/FontFile');
  });

  it('declares the exact byte length of the drawing it contains', () => {
    const text = asText(RECEIPT);
    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const stream = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    expect(Buffer.from(stream, 'latin1').byteLength).toBe(declared);
  });

  it('titles itself a salary payment receipt, for the company, the month and the payment', () => {
    const text = asText(RECEIPT);
    expect(text).toContain('Salary payment receipt');
    expect(text).toContain('Alpha Shield Security Ltd');
    expect(text).toContain('2026-08-01');
    expect(text).toContain('2026-08-31');
    expect(text).toContain('Paid on 2026-08-28, reference GCB-TRF-2026-08-0031');
  });

  it('omits the reference when the run was marked paid without one', () => {
    const text = asText({ ...RECEIPT, paymentReference: null });
    expect(text).toContain('Paid on 2026-08-28');
    expect(text).not.toContain('reference');
  });

  it('names the paying account, masked the same way as every other destination', () => {
    const text = asText(RECEIPT);
    expect(text).toContain('Akwaaba Bank');
    expect(text).toContain('Ridge');
    expect(text).toContain('**** 0123');
  });

  it('says plainly when the company has not set up a bank account yet', () => {
    const text = asText({
      ...RECEIPT,
      payingBankName: null,
      payingBranch: null,
      payingAccountNumberMasked: null,
    });
    expect(text).toContain('No bank account was on file');
  });

  it('prints one row per worker paid, with their staff number, name, destination and net pay', () => {
    const text = asText(RECEIPT);
    expect(text).toContain('SMT-00042');
    expect(text).toContain('Kwame Mensah');
    expect(text).toContain('**** 0123');
    expect(text).toContain('1,335.30');
    expect(text).toContain('SMT-00043');
    expect(text).toContain('Ama Boateng');
    // A row long enough to wrap still prints every word, just split across
    // two lines rather than cut off — the same rule `wrapToWidth` follows
    // everywhere else in these PDFs. "mobile money ending" starts the row;
    // its own last four digits are what the wrapped continuation carries.
    expect(text).toContain('mobile money ending');
    expect(text).toContain('4567');
    expect(text).toContain('963.20');
    expect(text).toContain('no payment details on');
    expect(text).toContain('500.00');
  });

  it('totals the workers paid and the net pay, counting every worker, not just those shown', () => {
    const text = asText(RECEIPT);
    expect(text).toContain('Total workers paid');
    // Courier right-aligns by character count, so the figure appears as its own token.
    expect(text).toContain('Total net pay');
    const totalNetPay = WORKERS.reduce((total, worker) => total + worker.netPayPesewas, 0);
    expect(totalNetPay).toBe(279_850);
    expect(text).toContain('2,798.50');
  });

  it('never runs a row off the page, however many workers are paid', () => {
    const many: PaymentReceiptWorkerInput[] = Array.from({ length: 400 }, (_, index) => ({
      staffNumber: `SMT-${String(index + 1).padStart(5, '0')}`,
      fullName: `Worker Number ${index + 1}`,
      netPayPesewas: 100_000,
      accountNumber: '1234567890123',
      momoNumber: null,
    }));
    const built = buildPaymentReceiptPdf({ ...RECEIPT, workers: many });
    const text = Buffer.from(built.bytes).toString('latin1');
    // Still exactly one page: this builder never grows a second one.
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('and ');
    expect(text).toContain('more, listed in full in the bank file.');
    // The totals still count every worker, including the ones left off the page.
    expect(text).toContain('400');
    expect(text).toContain(money(many.reduce((total, worker) => total + worker.netPayPesewas, 0)));
  });

  it('is byte-identical for the same input, like every PDF this codebase builds', () => {
    expect(buildPaymentReceiptPdf(RECEIPT).sha256).toBe(buildPaymentReceiptPdf(RECEIPT).sha256);
  });
});

describe('the file name', () => {
  it('names the month, not the run', () => {
    expect(paymentReceiptFileName('2026-08-31')).toBe('payroll-payment-receipt-2026-08.pdf');
  });
});
