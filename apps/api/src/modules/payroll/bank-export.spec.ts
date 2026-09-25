import { describe, expect, it } from 'vitest';
import {
  type BankDestination,
  bankExportCsv,
  csvCell,
  netPerEmployee,
  toGhs,
} from './bank-export.js';

/**
 * This file is the one output of the whole system that moves real money, so the
 * tests are about the ways a row could be forged or a column shifted.
 */

const PERIOD = { endDate: '2026-09-30' };
const APPROVED = new Date('2026-10-01T09:00:00Z');

const destination = (over: Partial<BankDestination> = {}): BankDestination => ({
  employeeId: 'employee-1',
  bankName: 'Akwaaba Bank',
  accountName: 'Kwame Mensah',
  accountNumber: '1234567890',
  momoNumber: null,
  updatedAt: new Date('2026-09-01T08:00:00Z'),
  ...over,
});

const row = (over: Partial<Parameters<typeof bankExportCsv>[0][number]> = {}) => ({
  employeeId: 'employee-1',
  staffNumber: 'SMT-00042',
  fullName: 'Kwame Mensah',
  netPayPesewas: 148_750,
  ...over,
});

describe('one cell of the bank file', () => {
  it('quotes everything, so a comma in a name cannot shift a column', () => {
    // Without this, the account number would land in the momo column, and
    // somebody would be paid with another person's details.
    expect(csvCell('Mensah, Kwame')).toBe('"Mensah, Kwame"');
  });

  it('doubles a quote inside, as the CSV standard requires', () => {
    expect(csvCell('Kwame "KK" Mensah')).toBe('"Kwame ""KK"" Mensah"');
  });

  it('writes an empty cell for anything absent, keeping the row the same width', () => {
    // A worker with no details on file must still appear, so somebody chases it.
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('puts an apostrophe in front of anything a spreadsheet would run', () => {
    // A payroll officer opens this in Excel before sending it.
    expect(csvCell('=HYPERLINK("http://example.invalid")')).toBe(
      '"\'=HYPERLINK(""http://example.invalid"")"',
    );
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('\tone')).toBe('"\'\tone"');
  });

  it('leaves an ordinary value exactly as it was', () => {
    expect(csvCell('Akwaaba Bank')).toBe('"Akwaaba Bank"');
    expect(csvCell('1234567890')).toBe('"1234567890"');
  });
});

describe('pesewas as cedis', () => {
  it('always shows two decimal places', () => {
    expect(toGhs(148_750)).toBe('1487.50');
    expect(toGhs(100)).toBe('1.00');
    expect(toGhs(5)).toBe('0.05');
    expect(toGhs(0)).toBe('0.00');
  });
});

describe('adding up a worker’s lines', () => {
  it('pays somebody once, however many lines they have', () => {
    const summed = netPerEmployee([
      { employeeId: 'a', staffNumber: 'SMT-00001', fullName: 'One', netPayPesewas: 100_000 },
      { employeeId: 'a', staffNumber: 'SMT-00001', fullName: 'One', netPayPesewas: -20_000 },
      { employeeId: 'b', staffNumber: 'SMT-00002', fullName: 'Two', netPayPesewas: 50_000 },
    ]);
    expect(summed).toHaveLength(2);
    expect(summed.find((person) => person.employeeId === 'a')?.netPayPesewas).toBe(80_000);
  });
});

describe('the bank file', () => {
  it('writes the ten columns the contract documents, in order', () => {
    const csv = bankExportCsv([], new Map(), PERIOD, APPROVED);
    expect(csv).toBe(
      '"staff_number","full_name","bank_name","account_name","account_number",' +
        '"momo_number","net_pay_pesewas","net_pay_ghs","employee_reference",' +
        '"details_changed_after_approval"',
    );
  });

  it('writes one row per worker, with the month in the reference', () => {
    const csv = bankExportCsv([row()], new Map([['employee-1', destination()]]), PERIOD, APPROVED);
    expect(csv.split('\n')[1]).toBe(
      '"SMT-00042","Kwame Mensah","Akwaaba Bank","Kwame Mensah","1234567890",' +
        '"","148750","1487.50","SAMTEC-2026-09-SMT-00042","no"',
    );
  });

  it('leaves out a row that would be a negative payment', () => {
    // A bank cannot take one. The line and the payslip still show it, and the
    // money comes back through an adjustment line next month.
    const csv = bankExportCsv(
      [
        row({ netPayPesewas: -15_275 }),
        row({ employeeId: 'employee-2', staffNumber: 'SMT-00043' }),
      ],
      new Map(),
      PERIOD,
      APPROVED,
    );
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('SMT-00043');
  });

  it('leaves out a row of exactly zero, which is nothing to send', () => {
    const csv = bankExportCsv([row({ netPayPesewas: 0 })], new Map(), PERIOD, APPROVED);
    expect(csv.split('\n')).toHaveLength(1);
  });

  it('sorts by staff number, so the file reads the same every time', () => {
    const csv = bankExportCsv(
      [
        row({ employeeId: 'c', staffNumber: 'SMT-00100' }),
        row({ employeeId: 'a', staffNumber: 'SMT-00007' }),
        row({ employeeId: 'b', staffNumber: 'SMT-00042' }),
      ],
      new Map(),
      PERIOD,
      APPROVED,
    );
    const numbers = csv
      .split('\n')
      .slice(1)
      .map((line) => line.split(',')[0]);
    expect(numbers).toEqual(['"SMT-00007"', '"SMT-00042"', '"SMT-00100"']);
  });

  it('still lists a worker whose details nobody has filled in', () => {
    const csv = bankExportCsv([row()], new Map(), PERIOD, APPROVED);
    const cells = csv.split('\n')[1]?.split(',');
    // Bank, account name, account number and momo are all empty, and the row
    // is still the full ten columns wide.
    expect(cells).toHaveLength(10);
    expect(cells?.slice(2, 6)).toEqual(['""', '""', '""', '""']);
  });

  it('says when a destination moved after the run was approved', () => {
    // Decision 22: the approval covered the amount, not where it was sent.
    const csv = bankExportCsv(
      [row()],
      new Map([['employee-1', destination({ updatedAt: new Date('2026-10-02T11:00:00Z') })]]),
      PERIOD,
      APPROVED,
    );
    expect(csv.split('\n')[1]?.endsWith('"yes"')).toBe(true);
  });

  it('says no when the destination was set before the approval', () => {
    const csv = bankExportCsv([row()], new Map([['employee-1', destination()]]), PERIOD, APPROVED);
    expect(csv.split('\n')[1]?.endsWith('"no"')).toBe(true);
  });

  it('cannot be made to forge an extra row', () => {
    // The worst case: a name carrying a line break and a comma, which without
    // quoting would add a whole fake payment to somebody else's account.
    const forged = bankExportCsv(
      [
        row({
          fullName:
            'Real Name"\n"SMT-99999","Ghost","Akwaaba Bank","Ghost","9999999999","","500000","5000.00","x","no',
        }),
      ],
      new Map([['employee-1', destination()]]),
      PERIOD,
      APPROVED,
    );
    // Two lines only: the header, and one real row split by the name's own
    // newline — which stays inside its quoted cell, so no bank reads it as a
    // second payment.
    const rows = forged.split('\n').filter((line) => line.startsWith('"SMT-'));
    expect(rows).toHaveLength(1);
    expect(forged).not.toContain('"SMT-99999","Ghost"');
    expect(forged).toContain('""SMT-99999""');
  });
});
