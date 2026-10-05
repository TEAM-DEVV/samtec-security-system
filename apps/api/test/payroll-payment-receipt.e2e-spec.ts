import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  tokensFor,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The company's own payment receipt
 * (`GET /payroll/runs/{runId}/payment-receipt.pdf`), against a real database.
 *
 * It exists only once a run is `PAID`, names the paying account and every
 * worker's destination masked to their last four digits, and — unlike the
 * bank export — needs no fresh password confirmation, because nothing it
 * prints is a number anybody could act on. The one fact every test here
 * protects is that a full account number or mobile money number never
 * reaches the page, whichever way a worker is paid.
 *
 * Makes its own company, for the same reason `payroll-approval.e2e-spec.ts`
 * does: nothing in payroll can be deleted, so a shared fixture company would
 * accumulate runs forever.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const RATES = {
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  sourceName: 'GRA PAYE rates 2026',
  sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
  sourceCheckedOn: new Date('2026-01-05T00:00:00Z'),
};

const BANDS = [
  { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
  { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
  { ordinal: 3, widthPesewas: 50_000, rateBasisPoints: 1000 },
  { ordinal: 4, widthPesewas: 200_000, rateBasisPoints: 1750 },
  { ordinal: 5, widthPesewas: null, rateBasisPoints: 2500 },
];

describe.skipIf(!databaseUrl)('the payment receipt (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  const BANK_WORKER = { accountNumber: '1234567890123', momoNumber: null };
  const MOMO_WORKER = { accountNumber: null, momoNumber: '+233241234567' };

  /**
   * Every worker `worker()` has ever made, in this whole file. Nobody is ever
   * terminated, so each one stays employed — and so paid, and so on the hook
   * for rule R3 — in every period calculated from here on, exactly like
   * `payroll-approval.e2e-spec.ts`'s own `payrollWorkers`. `paidRun` gives
   * fresh attendance to all of them for its month, not just the ones the
   * current test created.
   */
  const payrollWorkers: string[] = [];

  /** One employee, paid a fixed salary, with the given payment details (or none at all). */
  let workersMade = 0;
  const worker = async (
    details: { accountNumber: string | null; momoNumber: string | null } | null,
  ) => {
    workersMade += 1;
    const n = String(workersMade).padStart(3, '0');
    const hiredOn = new Date('2024-01-01T00:00:00Z');
    const created = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-8${n}`,
        firstName: 'Receipt',
        lastName: `Worker ${workersMade}`,
        phone: `+2332071${n}0`,
        ghanaCardNumber: `GHA-71${n}00000-${workersMade % 10}`,
        position: 'Security Guard',
        status: 'ACTIVE',
        hireDate: hiredOn,
      },
    });
    await prisma.employmentPeriod.create({
      data: {
        companyId: company.companyId,
        employeeId: created.id,
        startsOn: hiredOn,
        endsOn: null,
      },
    });
    await prisma.employeePayTerms.create({
      data: {
        companyId: company.companyId,
        employeeId: created.id,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        basicMonthlyPesewas: 150_000,
        overtimeHourlyPesewas: 0,
        createdByUserId: company.adminUserId,
      },
    });
    if (details !== null) {
      await prisma.employeePaymentDetails.create({
        data: {
          companyId: company.companyId,
          employeeId: created.id,
          bankName: details.accountNumber === null ? null : 'Fictional Bank of Accra',
          accountName: details.accountNumber === null ? null : 'A Paid Worker',
          accountNumber: details.accountNumber,
          momoNumber: details.momoNumber,
          updatedByUserId: company.adminUserId,
        },
      });
    }
    payrollWorkers.push(created.id);
    return created.id;
  };

  /** Confirmed attendance for one worker across one month, so R3 lets the run through. */
  const giveAttendance = async (employeeId: string, period: { startsOn: Date; endsOn: Date }) => {
    const rows = [];
    for (let day = 0; day < 20; day += 1) {
      const workDate = new Date(
        Date.UTC(period.startsOn.getUTCFullYear(), period.startsOn.getUTCMonth(), 1 + day),
      );
      if (workDate > period.endsOn) break;
      rows.push({
        companyId: company.companyId,
        employeeId,
        siteId: company.siteA,
        workDate,
        startedAt: new Date(workDate.getTime() + 6 * 3_600_000),
        endedAt: new Date(workDate.getTime() + 14 * 3_600_000),
        workedMinutes: 480,
        basis: 'MANUAL' as const,
        status: 'CONFIRMED' as const,
      });
    }
    await prisma.workSegment.createMany({ data: rows });
  };

  /**
   * A fresh month each time it is called — every test that pays a run needs
   * its own, exactly like `payroll-approval.e2e-spec.ts`'s `draftRun`, since
   * nothing in payroll can be deleted and a company takes at most one
   * approved run per month. Gives every worker made so far fresh attendance,
   * because every one of them is still employed and so is on this run too.
   */
  let monthsUsed = 0;
  const paidRun = async () => {
    monthsUsed += 1;
    const year = 2070 + Math.floor((monthsUsed - 1) / 12);
    const month = ((monthsUsed - 1) % 12) + 1;
    const existingTable = await prisma.taxTable.findFirst({
      where: { companyId: company.companyId, taxYear: year },
    });
    if (existingTable === null) {
      await prisma.taxTable.create({
        data: {
          companyId: company.companyId,
          taxYear: year,
          effectiveFrom: new Date(Date.UTC(year, 0, 1)),
          ...RATES,
          createdByUserId: company.adminUserId,
          bands: { create: BANDS.map((band) => ({ companyId: company.companyId, ...band })) },
        },
      });
    }
    const period = await api()
      .post('/api/v1/payroll/periods')
      .set(...bearer(token.hr))
      .send({ year, month })
      .expect(201);
    const bounds = {
      startsOn: new Date(Date.UTC(year, month - 1, 1)),
      endsOn: new Date(Date.UTC(year, month, 0)),
    };
    for (const employeeId of payrollWorkers) {
      await giveAttendance(employeeId, bounds);
    }
    const run = await api()
      .post('/api/v1/payroll/runs')
      .set(...bearer(token.hr))
      .send({ periodId: period.body.id })
      .expect(201);
    const runId = run.body.id as string;
    await api()
      .post(`/api/v1/payroll/runs/${runId}/submit`)
      .set(...bearer(token.hr))
      .send({})
      .expect(200);
    await api()
      .post(`/api/v1/payroll/runs/${runId}/approve`)
      .set(...bearer(token.admin))
      .send({})
      .expect(200);
    await api()
      .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
      .set(...bearer(token.admin))
      .send({ paidOn: '2026-09-20', paymentReference: 'GCB-TRF-2026-09-0099' })
      .expect(200);
    return { runId, periodEndDate: period.body.endDate as string };
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    await prisma.company.update({
      where: { id: company.companyId },
      data: {
        bankName: 'Akwaaba Bank',
        branch: 'Ridge',
        accountName: company.companyId,
        accountNumber: '9988776655443',
      },
    });
    app = await createDbTestApp(databaseUrl as string);
    token = await tokensFor(app, company);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('answers 409 before the run is paid: a draft, a submitted run, and a locked one', async () => {
    const bankWorker = await worker(BANK_WORKER);
    const period = await api()
      .post('/api/v1/payroll/periods')
      .set(...bearer(token.hr))
      .send({ year: 2062, month: 1 })
      .expect(201);
    await prisma.taxTable.create({
      data: {
        companyId: company.companyId,
        taxYear: 2062,
        effectiveFrom: new Date('2062-01-01T00:00:00Z'),
        ...RATES,
        createdByUserId: company.adminUserId,
        bands: { create: BANDS.map((band) => ({ companyId: company.companyId, ...band })) },
      },
    });
    await giveAttendance(bankWorker, {
      startsOn: new Date('2062-01-01T00:00:00Z'),
      endsOn: new Date('2062-01-31T00:00:00Z'),
    });
    const run = await api()
      .post('/api/v1/payroll/runs')
      .set(...bearer(token.hr))
      .send({ periodId: period.body.id })
      .expect(201);
    const runId = run.body.id as string;

    await api()
      .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
      .set(...bearer(token.hr))
      .expect(409);

    await api()
      .post(`/api/v1/payroll/runs/${runId}/submit`)
      .set(...bearer(token.hr))
      .send({})
      .expect(200);
    await api()
      .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
      .set(...bearer(token.hr))
      .expect(409);

    await api()
      .post(`/api/v1/payroll/runs/${runId}/approve`)
      .set(...bearer(token.admin))
      .send({})
      .expect(200);
    await api()
      .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
      .set(...bearer(token.hr))
      .expect(409);
  });

  it('is a PDF naming the company, the paying account, every destination masked, and the totals', async () => {
    // paidRun gives every worker made so far fresh attendance and pays them
    // all; these three just need to exist, one of each destination type.
    await worker(BANK_WORKER);
    await worker(MOMO_WORKER);
    await worker(null);
    const { runId, periodEndDate } = await paidRun();

    const file = await api()
      .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
      .set(...bearer(token.hr))
      .expect(200);

    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="payroll-payment-receipt-${periodEndDate.slice(0, 7)}.pdf"`,
    );
    expect(file.headers['cache-control']).toBe('no-store');

    const text = Buffer.from(file.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Salary payment receipt');
    expect(text).toContain('Paid on 2026-09-20, reference GCB-TRF-2026-09-0099');
    // The paying account: masked, bank and branch named in full.
    expect(text).toContain('Akwaaba Bank');
    expect(text).toContain('Ridge');
    expect(text).toContain('**** 5443');
    // Every worker, by their own destination. A row long enough to wrap
    // still prints every word, just split across lines rather than cut off —
    // which is where the wrap happens to fall depends on exact name widths,
    // so these check the words are present without assuming one exact line.
    expect(text).toContain('**** 0123');
    expect(text).toContain('ending 4567');
    expect(text).toContain('no payment');
    expect(text).toContain('file');
    // Not one full account or mobile money number anywhere on the page.
    expect(text).not.toContain('1234567890123');
    expect(text).not.toContain('241234567');
    expect(text).not.toContain('9988776655443');
  });

  it('shows the paid day and the reference on every payslip of the run, without touching the stored PDF', async () => {
    const { runId } = await paidRun();
    const payslips = await api()
      .get(`/api/v1/payroll/payslips?runId=${runId}`)
      .set(...bearer(token.admin))
      .expect(200);
    expect(payslips.body.items.length).toBeGreaterThan(0);
    for (const payslip of payslips.body.items) {
      expect(payslip.runStatus).toBe('PAID');
      expect(payslip.paidOn).toBe('2026-09-20');
      expect(payslip.paymentReference).toBe('GCB-TRF-2026-09-0099');
    }

    // The file itself is the one made when the run locked: the paid stamp
    // lives in the JSON, never in a rebuilt PDF.
    const first = payslips.body.items[0];
    const stored = await prisma.payslip.findUniqueOrThrow({ where: { id: first.id } });
    const download = await api()
      .get(`/api/v1/payroll/payslips/${first.id}/pdf`)
      .set(...bearer(token.admin))
      .expect(200);
    expect(Buffer.from(download.body as Buffer).equals(Buffer.from(stored.pdf))).toBe(true);
    expect(Buffer.from(download.body as Buffer).toString('latin1')).not.toContain('Paid on');
  });

  it('refuses a supervisor and a guard, the same as every other payroll download', async () => {
    await worker(BANK_WORKER);
    const { runId } = await paidRun();
    for (const forbidden of [token.supervisor, token.guard]) {
      await api()
        .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
        .set(...bearer(forbidden))
        .expect(403);
    }
  });

  it('records who read it and for which run, and never an account number', async () => {
    await worker(BANK_WORKER);
    const { runId } = await paidRun();
    await api()
      .get(`/api/v1/payroll/runs/${runId}/payment-receipt.pdf`)
      .set(...bearer(token.admin))
      .expect(200);

    const audited = await prisma.auditLog.findFirst({
      where: {
        companyId: company.companyId,
        action: 'payroll.payment_receipt_downloaded',
        entityId: runId,
      },
    });
    expect(audited).not.toBeNull();
    expect(audited?.actorUserId).toBe(company.adminUserId);
    expect(JSON.stringify(audited?.detail)).not.toContain(BANK_WORKER.accountNumber);
  });
});
