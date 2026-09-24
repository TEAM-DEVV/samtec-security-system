import { describe, expect, it } from 'vitest';
import type {
  EmployeePaymentDetails,
  EmployeePayTerms,
  PayrollPeriod,
} from '../../generated/prisma/client.js';
import {
  type TaxTableWithBands,
  toApiPaymentDetails,
  toApiPayTerms,
  toApiPeriod,
  toApiTaxTable,
} from './payroll-mapping.js';

/**
 * These tests are the reason the mapping is a pure function.
 *
 * Two mistakes are easy to make here and invisible once made: a `@db.Date`
 * column sent out as a full timestamp, which is a different day for anybody
 * reading it, and a nullable column mapped to the wrong thing. Both are
 * caught by comparing whole results, so a field nobody thought about cannot
 * quietly change shape.
 */

const COMPANY = '01927c3e-0000-7000-8000-00000000c001';
const USER = '01927c3e-0000-7000-8000-00000000u001';

/** Midnight UTC, which is how Prisma hands back a `@db.Date` column. */
const day = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const moment = (iso: string) => new Date(iso);

describe('a payroll month', () => {
  const row: PayrollPeriod = {
    id: 'period-1',
    companyId: COMPANY,
    year: 2026,
    month: 9,
    startsOn: day('2026-09-01'),
    endsOn: day('2026-09-30'),
    status: 'OPEN',
    closedAt: null,
    closedByUserId: null,
    createdAt: moment('2026-08-25T09:15:00.000Z'),
    updatedAt: moment('2026-08-25T09:15:00.000Z'),
  };

  it('sends the two dates as calendar dates, never as timestamps', () => {
    expect(toApiPeriod(row, null)).toEqual({
      id: 'period-1',
      year: 2026,
      month: 9,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      status: 'OPEN',
      closedAt: null,
      closedByUserId: null,
      lockedRunId: null,
      createdAt: '2026-08-25T09:15:00.000Z',
      updatedAt: '2026-08-25T09:15:00.000Z',
    });
  });

  it('carries who closed it and when, once it is closed', () => {
    const closed = toApiPeriod(
      {
        ...row,
        status: 'CLOSED',
        closedAt: moment('2026-10-02T11:00:00.000Z'),
        closedByUserId: USER,
      },
      'run-9',
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).toBe('2026-10-02T11:00:00.000Z');
    expect(closed.closedByUserId).toBe(USER);
    expect(closed.lockedRunId).toBe('run-9');
  });

  it('never leaks the company it belongs to', () => {
    // The caller already knows their own company, and a record that carried it
    // would make a cross-tenant mistake harder to see.
    expect(Object.keys(toApiPeriod(row, null))).not.toContain('companyId');
  });
});

describe('a version of the statutory rates', () => {
  const band = (ordinal: number, widthPesewas: number | null, rateBasisPoints: number) => ({
    id: `band-${ordinal}`,
    companyId: COMPANY,
    taxTableId: 'table-1',
    ordinal,
    widthPesewas,
    rateBasisPoints,
    createdAt: moment('2026-01-05T00:00:00.000Z'),
  });

  const row: TaxTableWithBands = {
    id: 'table-1',
    companyId: COMPANY,
    taxYear: 2026,
    effectiveFrom: day('2026-01-01'),
    effectiveTo: null,
    ssnitEmployeeBasisPoints: 550,
    ssnitEmployerBasisPoints: 1300,
    ssnitTier1BasisPoints: 1350,
    ssnitTier2BasisPoints: 500,
    sourceName: 'GRA PAYE rates 2026',
    sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
    sourceCheckedOn: day('2026-01-05'),
    createdAt: moment('2026-01-05T08:00:00.000Z'),
    createdByUserId: USER,
    // Deliberately out of order: the ordinal decides, not the query.
    bands: [band(3, null, 3500), band(1, 49_000, 0), band(2, 10_000, 500)],
  };

  it('puts the bands in order, because the order is part of what they mean', () => {
    // Band 2 taxes the slice above band 1. Read in another order the rates
    // would apply to the wrong money.
    expect(toApiTaxTable(row).bands).toEqual([
      { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
      { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
      { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 },
    ]);
  });

  it('sends its three dates as calendar dates and its timestamp as a timestamp', () => {
    const mapped = toApiTaxTable(row);
    expect(mapped.effectiveFrom).toBe('2026-01-01');
    expect(mapped.effectiveTo).toBeNull();
    expect(mapped.sourceCheckedOn).toBe('2026-01-05');
    expect(mapped.createdAt).toBe('2026-01-05T08:00:00.000Z');
  });

  it('keeps an end date when the version has one', () => {
    expect(toApiTaxTable({ ...row, effectiveTo: day('2026-12-31') }).effectiveTo).toBe(
      '2026-12-31',
    );
  });

  it('leaves the bands it was given alone', () => {
    // The sort must not reorder the caller's array underneath them.
    const given = [...row.bands];
    toApiTaxTable(row);
    expect(row.bands).toEqual(given);
  });
});

describe('what a worker is paid', () => {
  const row: EmployeePayTerms = {
    id: 'terms-1',
    companyId: COMPANY,
    employeeId: 'employee-1',
    effectiveFrom: day('2026-01-01'),
    basicMonthlyPesewas: 150_000,
    overtimeHourlyPesewas: 900,
    taxableAllowancePesewas: 15_000,
    nonTaxableAllowancePesewas: 5_000,
    otherDeductionPesewas: 2_000,
    createdAt: moment('2025-12-20T10:00:00.000Z'),
    createdByUserId: USER,
  };

  it('sends every amount through untouched, and the date as a date', () => {
    expect(toApiPayTerms(row)).toEqual({
      id: 'terms-1',
      employeeId: 'employee-1',
      effectiveFrom: '2026-01-01',
      basicMonthlyPesewas: 150_000,
      overtimeHourlyPesewas: 900,
      taxableAllowancePesewas: 15_000,
      nonTaxableAllowancePesewas: 5_000,
      otherDeductionPesewas: 2_000,
      createdAt: '2025-12-20T10:00:00.000Z',
      createdByUserId: USER,
    });
  });
});

describe('where the money is sent', () => {
  const row: EmployeePaymentDetails = {
    id: 'details-1',
    companyId: COMPANY,
    employeeId: 'employee-1',
    bankName: 'Akwaaba Bank',
    accountName: 'Kwame Mensah',
    accountNumber: '1234567890',
    momoNumber: null,
    createdAt: moment('2026-02-01T10:00:00.000Z'),
    updatedAt: moment('2026-03-05T14:30:00.000Z'),
    updatedByUserId: USER,
  };

  it('is addressed by the employee, and carries no id of its own', () => {
    const mapped = toApiPaymentDetails(row);
    expect(mapped).toEqual({
      employeeId: 'employee-1',
      bankName: 'Akwaaba Bank',
      accountName: 'Kwame Mensah',
      accountNumber: '1234567890',
      momoNumber: null,
      updatedAt: '2026-03-05T14:30:00.000Z',
      updatedByUserId: USER,
    });
    expect(Object.keys(mapped)).not.toContain('id');
    expect(Object.keys(mapped)).not.toContain('companyId');
  });

  it('keeps a mobile money number and an absent bank apart', () => {
    const momoOnly = toApiPaymentDetails({
      ...row,
      bankName: null,
      accountName: null,
      accountNumber: null,
      momoNumber: '+233241234567',
    });
    expect(momoOnly.accountNumber).toBeNull();
    expect(momoOnly.momoNumber).toBe('+233241234567');
  });
});
