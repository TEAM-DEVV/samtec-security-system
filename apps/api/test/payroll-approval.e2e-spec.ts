import { randomUUID } from 'node:crypto';
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
 * Approving and paying a payroll run, against a real database
 * (docs/plan/09-payroll-engine-ghana.md, decisions 16, 17, 22 and 23).
 *
 * This is where the money actually leaves, so the tests are mostly about the
 * refusals: the maker is never the checker, a locked run never changes, a
 * rejection is final, and the bank file cannot be forged or read early.
 *
 * Each run makes its own company, because nothing in payroll may ever be
 * deleted — see `src/modules/payroll/README.md`.
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

describe.skipIf(!databaseUrl)('Approving and paying a payroll run (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  let workersMade = 0;
  const worker = async (basicMonthlyPesewas = 150_000) => {
    workersMade += 1;
    const n = String(workersMade).padStart(3, '0');
    const hiredOn = new Date('2024-01-01T00:00:00Z');
    const created = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-7${n}`,
        firstName: 'Paid',
        lastName: `Worker ${workersMade}`,
        phone: `+2332070${n}0`,
        ghanaCardNumber: `GHA-70${n}00000-${workersMade % 10}`,
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
        basicMonthlyPesewas,
        overtimeHourlyPesewas: 0,
        createdByUserId: company.adminUserId,
      },
    });
    return { id: created.id, staffNumber: created.staffNumber };
  };

  let monthsUsed = 0;
  /** A month with rates, and a draft run in it calculated by the payroll officer. */
  const draftRun = async () => {
    monthsUsed += 1;
    const year = 2060 + Math.floor((monthsUsed - 1) / 12);
    const month = ((monthsUsed - 1) % 12) + 1;
    const table = await prisma.taxTable.findFirst({
      where: { companyId: company.companyId, taxYear: year },
    });
    if (table === null) {
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
    const run = await api()
      .post('/api/v1/payroll/runs')
      .set(...bearer(token.hr))
      .send({ periodId: period.body.id })
      .expect(201);
    return { periodId: period.body.id as string, runId: run.body.id as string };
  };

  /** A run waiting for a checker, submitted by the payroll officer who made it. */
  const submitted = async () => {
    const { periodId, runId } = await draftRun();
    await api()
      .post(`/api/v1/payroll/runs/${runId}/submit`)
      .set(...bearer(token.hr))
      .send({})
      .expect(200);
    return { periodId, runId };
  };

  /** A run already approved by the administrator. */
  const locked = async () => {
    const { periodId, runId } = await submitted();
    await api()
      .post(`/api/v1/payroll/runs/${runId}/approve`)
      .set(...bearer(token.admin))
      .send({})
      .expect(200);
    return { periodId, runId };
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    token = await tokensFor(app, company);
    await worker(200_000);
    await worker(120_000);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe('the maker is never the checker', () => {
    it('lets only the person who calculated a run submit it', async () => {
      const { runId } = await draftRun();
      // Calculated by the payroll officer, so the administrator may not submit.
      await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.admin))
        .send({})
        .expect(403);
      await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(200);
    });

    it('refuses the submitter approving their own run, even as an administrator', async () => {
      const { periodId } = await draftRun();
      // The administrator calculates and submits this one themselves.
      const own = await api()
        .post('/api/v1/payroll/runs')
        .set(...bearer(token.admin))
        .send({ periodId })
        .expect(201);
      await api()
        .post(`/api/v1/payroll/runs/${own.body.id}/submit`)
        .set(...bearer(token.admin))
        .send({})
        .expect(200);

      // They may not now approve it. This is the rule the whole phase exists for.
      const refused = await api()
        .post(`/api/v1/payroll/runs/${own.body.id}/approve`)
        .set(...bearer(token.admin))
        .send({})
        .expect(403);
      expect(JSON.stringify(refused.body)).toMatch(/second pair of eyes/);

      // A different administrator can.
      await api()
        .post(`/api/v1/payroll/runs/${own.body.id}/approve`)
        .set(...bearer(token.secondAdmin))
        .send({})
        .expect(200);
    });

    it('refuses the same person rejecting their own run', async () => {
      const { periodId } = await draftRun();
      const own = await api()
        .post('/api/v1/payroll/runs')
        .set(...bearer(token.admin))
        .send({ periodId })
        .expect(201);
      await api()
        .post(`/api/v1/payroll/runs/${own.body.id}/submit`)
        .set(...bearer(token.admin))
        .send({})
        .expect(200);
      await api()
        .post(`/api/v1/payroll/runs/${own.body.id}/reject`)
        .set(...bearer(token.admin))
        .send({ reason: 'The overtime looks wrong to me.' })
        .expect(403);
    });

    it('refuses a payroll officer approving anything at all', async () => {
      const { runId } = await submitted();
      // Approving is an administrator's job, whoever made the run.
      await api()
        .post(`/api/v1/payroll/runs/${runId}/approve`)
        .set(...bearer(token.hr))
        .send({})
        .expect(403);
      await api()
        .post(`/api/v1/payroll/runs/${runId}/reject`)
        .set(...bearer(token.hr))
        .send({ reason: 'Not mine to decide.' })
        .expect(403);
      await api()
        .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
        .set(...bearer(token.hr))
        .send({ paidOn: '2026-09-20' })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('the run moves forward, and only forward', () => {
    it('records who submitted it and when, together', async () => {
      const { runId } = await draftRun();
      const sent = await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({ note: 'September, with the new guards included.' })
        .expect(200);
      expect(sent.body.status).toBe('PENDING_APPROVAL');
      expect(sent.body.submittedByUserId).toBe(company.hrUserId);
      expect(sent.body.submittedAt).not.toBeNull();
      expect(sent.body.submissionNote).toBe('September, with the new guards included.');
    });

    it('refuses submitting the same run twice', async () => {
      const { runId } = await submitted();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(409);
    });

    it('refuses approving a draft that nobody has submitted', async () => {
      const { runId } = await draftRun();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/approve`)
        .set(...bearer(token.admin))
        .send({})
        .expect(409);
    });

    it('will not reopen a rejected run, because a rejection is final', async () => {
      const { runId } = await submitted();
      const sent_back = await api()
        .post(`/api/v1/payroll/runs/${runId}/reject`)
        .set(...bearer(token.admin))
        .send({ reason: 'The overtime for the night shift is double counted.' })
        .expect(200);
      expect(sent_back.body.status).toBe('REJECTED');
      expect(sent_back.body.rejectionReason).toBe(
        'The overtime for the night shift is double counted.',
      );

      // Nothing more can happen to it. The answer is a new draft.
      for (const step of ['approve', 'submit', 'mark-paid']) {
        await api()
          .post(`/api/v1/payroll/runs/${runId}/${step}`)
          .set(...bearer(step === 'submit' ? token.hr : token.admin))
          .send(step === 'mark-paid' ? { paidOn: '2026-09-20' } : {})
          .expect(409);
      }
    });

    it('refuses a rejection with no reason', async () => {
      const { runId } = await submitted();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/reject`)
        .set(...bearer(token.admin))
        .send({})
        .expect(400);
    });

    it('marks an approved run paid, and refuses a payment date in the future', async () => {
      const { runId } = await locked();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
        .set(...bearer(token.admin))
        .send({ paidOn: '2099-01-01' })
        .expect(400);

      const paid = await api()
        .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
        .set(...bearer(token.admin))
        .send({ paidOn: '2026-09-20', paymentReference: 'AKB-TRF-2026-09-0042' })
        .expect(200);
      expect(paid.body.status).toBe('PAID');
      expect(paid.body.paidOn).toBe('2026-09-20');
      expect(paid.body.paymentReference).toBe('AKB-TRF-2026-09-0042');

      // And not twice.
      await api()
        .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
        .set(...bearer(token.admin))
        .send({ paidOn: '2026-09-21' })
        .expect(409);
    });

    it('allows only one approved run in a month', async () => {
      const { periodId } = await locked();
      const second = await api()
        .post('/api/v1/payroll/runs')
        .set(...bearer(token.hr))
        .send({ periodId })
        .expect(201);
      await api()
        .post(`/api/v1/payroll/runs/${second.body.id}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(200);
      // The database refuses a second approved run for the month.
      await api()
        .post(`/api/v1/payroll/runs/${second.body.id}/approve`)
        .set(...bearer(token.admin))
        .send({})
        .expect(409);
    });

    it('answers 404 for a run that does not exist, before anything else', async () => {
      await api()
        .post(`/api/v1/payroll/runs/${randomUUID()}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('approving makes the payslips', () => {
    it('writes one payslip for every line, in the same breath as the approval', async () => {
      const { runId } = await locked();
      const lines = await api()
        .get(`/api/v1/payroll/runs/${runId}/lines?limit=100`)
        .set(...bearer(token.hr))
        .expect(200);
      const payslips = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}&limit=100`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(payslips.body.items).toHaveLength(lines.body.items.length);
      expect(payslips.body.items.length).toBeGreaterThan(0);
    });

    it('gives each payslip the figures of its own line, and the rates of its run', async () => {
      const { runId } = await locked();
      const lines = await api()
        .get(`/api/v1/payroll/runs/${runId}/lines?limit=100`)
        .set(...bearer(token.hr))
        .expect(200);
      const payslips = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}&limit=100`)
        .set(...bearer(token.hr))
        .expect(200);

      for (const line of lines.body.items) {
        const slip = payslips.body.items.find(
          (item: { lineId: string }) => item.lineId === line.id,
        );
        expect(slip).toBeDefined();
        expect(slip.netPayPesewas).toBe(line.netPayPesewas);
        expect(slip.grossPesewas).toBe(line.grossPesewas);
        expect(slip.payePesewas).toBe(line.payePesewas);
        // The rates are on the payslip but not on the line.
        expect(slip.ssnitEmployeeBasisPoints).toBe(550);
        expect(slip.ssnitEmployerBasisPoints).toBe(1300);
        expect(slip.runStatus).toBe('LOCKED');
        expect(slip.paidAt).toBeNull();
        expect(slip.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(slip.pdfSizeBytes).toBeGreaterThan(1_000);
      }
    });

    it('shows the payment on the payslip once the run is paid', async () => {
      const { runId } = await locked();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/mark-paid`)
        .set(...bearer(token.admin))
        .send({ paidOn: '2026-09-20' })
        .expect(200);
      const payslips = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}`)
        .set(...bearer(token.hr))
        .expect(200);
      // These two are read live from the run; everything else is frozen.
      expect(payslips.body.items[0].runStatus).toBe('PAID');
      expect(payslips.body.items[0].paidAt).not.toBeNull();
    });

    it('hands back a real PDF, named after the worker and the month', async () => {
      const { runId } = await locked();
      const payslips = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}`)
        .set(...bearer(token.hr))
        .expect(200);
      const slip = payslips.body.items[0];

      const file = await api()
        .get(`/api/v1/payroll/payslips/${slip.id}/pdf`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toMatch(
        new RegExp(
          `attachment; filename="payslip-${slip.employee.staffNumber}-\\d{4}-\\d{2}\\.pdf"`,
        ),
      );
      expect(file.headers['cache-control']).toBe('no-store');
      // Genuinely a PDF, and the very bytes that were stored.
      expect(file.body.subarray(0, 8).toString()).toBe('%PDF-1.4');
      expect(file.body.length).toBe(slip.pdfSizeBytes);
    });

    it('records who downloaded a payslip, and no figure from it', async () => {
      const { runId } = await locked();
      const payslips = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}`)
        .set(...bearer(token.hr))
        .expect(200);
      await api()
        .get(`/api/v1/payroll/payslips/${payslips.body.items[0].id}/pdf`)
        .set(...bearer(token.hr))
        .expect(200);

      const entries = await prisma.auditLog.findMany({
        where: { companyId: company.companyId, action: 'payroll.payslip_downloaded' },
      });
      expect(entries.length).toBeGreaterThan(0);
      const written = JSON.stringify(entries);
      expect(written).toMatch(/ownPayslip/);
      // No money in the log, ever.
      expect(written).not.toMatch(/netPay|grossPesewas/);
    });
  });

  // -------------------------------------------------------------------------

  describe('a guard and their own payslip', () => {
    it('lets a guard read their own, and nobody else’s', async () => {
      const { runId } = await locked();
      const all = await api()
        .get(`/api/v1/payroll/payslips?runId=${runId}&limit=100`)
        .set(...bearer(token.hr))
        .expect(200);

      const theirs = all.body.items.find(
        (item: { employee: { id: string } }) => item.employee.id === company.active.id,
      );
      const somebodyElse = all.body.items.find(
        (item: { employee: { id: string } }) => item.employee.id !== company.active.id,
      );

      // A guard's list is their own, however they ask.
      const mine = await api()
        .get('/api/v1/payroll/payslips?limit=100')
        .set(...bearer(token.guard))
        .expect(200);
      for (const item of mine.body.items) {
        expect(item.employee.id).toBe(company.active.id);
      }

      if (theirs !== undefined) {
        await api()
          .get(`/api/v1/payroll/payslips/${theirs.id}`)
          .set(...bearer(token.guard))
          .expect(200);
      }
      if (somebodyElse !== undefined) {
        // 404 and not 403, so nobody learns which payslips exist.
        await api()
          .get(`/api/v1/payroll/payslips/${somebodyElse.id}`)
          .set(...bearer(token.guard))
          .expect(404);
        await api()
          .get(`/api/v1/payroll/payslips/${somebodyElse.id}/pdf`)
          .set(...bearer(token.guard))
          .expect(404);
      }
    });

    it('refuses a supervisor every payslip in the company', async () => {
      await api()
        .get('/api/v1/payroll/payslips')
        .set(...bearer(token.supervisor))
        .expect(403);
    });

    it('never lets a payslip be cached', async () => {
      const listed = await api()
        .get('/api/v1/payroll/payslips')
        .set(...bearer(token.hr))
        .expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
    });
  });

  // -------------------------------------------------------------------------

  describe('the bank file', () => {
    it('exists only once the run has been approved', async () => {
      const { runId } = await submitted();
      await api()
        .get(`/api/v1/payroll/runs/${runId}/bank-export`)
        .set(...bearer(token.hr))
        .expect(409);
    });

    it('is a download, never cached, with a row for each worker paid', async () => {
      const { runId } = await locked();
      const file = await api()
        .get(`/api/v1/payroll/runs/${runId}/bank-export`)
        .set(...bearer(token.hr))
        .expect(200);

      expect(file.headers['content-type']).toContain('text/csv');
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="payroll-run-${runId}.csv"`,
      );
      expect(file.headers['cache-control']).toBe('no-store');

      const csv = file.text ?? file.body.toString();
      const rows = csv.trim().split('\n');
      expect(rows[0]).toContain('"staff_number"');
      expect(rows[0]).toContain('"details_changed_after_approval"');
      expect(rows.length).toBeGreaterThan(1);
      // Every cell is quoted, so no name can shift a column.
      for (const line of rows) {
        expect(line.startsWith('"')).toBe(true);
        expect(line.endsWith('"')).toBe(true);
      }
    });

    it('records who downloaded it, and not one digit of what they got', async () => {
      const { runId } = await locked();
      await api()
        .get(`/api/v1/payroll/runs/${runId}/bank-export`)
        .set(...bearer(token.hr))
        .expect(200);

      const entries = await prisma.auditLog.findMany({
        where: { companyId: company.companyId, action: 'payroll.bank_file_downloaded' },
      });
      expect(entries.length).toBeGreaterThan(0);
      const written = JSON.stringify(entries);
      expect(written).toMatch(/rowCount/);
      expect(written).not.toMatch(/\d{10}/);
    });

    it('refuses a supervisor and a guard, who must never see account numbers', async () => {
      const { runId } = await locked();
      for (const who of [token.supervisor, token.guard]) {
        await api()
          .get(`/api/v1/payroll/runs/${runId}/bank-export`)
          .set(...bearer(who))
          .expect(403);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('a locked run never changes', () => {
    it('refuses every edit to an approved run and its lines', async () => {
      const { runId } = await locked();
      // The service refuses it, and so would the database underneath.
      await expect(
        prisma.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT' } }),
      ).rejects.toThrow();
      await expect(
        prisma.payrollLine.updateMany({ where: { runId }, data: { netPayPesewas: 1 } }),
      ).rejects.toThrow();
    });

    it('refuses a payslip being changed or removed after the fact', async () => {
      const { runId } = await locked();
      const payslip = await prisma.payslip.findFirstOrThrow({ where: { runId } });
      await expect(
        prisma.payslip.update({ where: { id: payslip.id }, data: { pdfSizeBytes: 1 } }),
      ).rejects.toThrow();
      await expect(prisma.payslip.delete({ where: { id: payslip.id } })).rejects.toThrow();
    });
  });
});
