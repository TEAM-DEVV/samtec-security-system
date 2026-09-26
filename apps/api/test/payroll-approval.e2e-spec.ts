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

/**
 * Fictional payment details for the fixture's workers.
 *
 * The audit test below needs a real account number to look for. Without one it
 * could only search for "any long run of digits", and a `uuid(7)` sometimes
 * happens to contain one — which made the test fail at random.
 */
const PAY_TO = {
  bankName: 'Fictional Bank of Accra',
  accountName: 'A Paid Worker',
  accountNumber: '9876500011',
  momoNumber: '+233209876500',
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

  /** Everybody who should be paid, so each new month can give them attendance. */
  const payrollWorkers: string[] = [];

  /**
   * Confirmed attendance for one worker across one month.
   *
   * Rule R3 refuses a run that pays somebody the attendance records do not
   * support, and a worker with no attendance at all is the plainest case of
   * that. So the fixture's workers work: twenty days of eight hours, which is
   * what makes an ordinary run submittable.
   *
   * `MANUAL` is the basis because there are no punches behind these — a
   * database CHECK requires both punch IDs for any other basis.
   */
  const giveAttendance = async (
    employeeId: string,
    period: { startsOn: Date; endsOn: Date },
    days = 20,
  ) => {
    const start = period.startsOn;
    const rows = [];
    for (let day = 0; day < days; day += 1) {
      const workDate = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + day),
      );
      if (workDate > period.endsOn) {
        break;
      }
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
    await prisma.employeePaymentDetails.create({
      data: {
        companyId: company.companyId,
        employeeId: created.id,
        ...PAY_TO,
        // A unique number per worker, so nothing collides.
        accountNumber: `${PAY_TO.accountNumber.slice(0, -3)}${n}`,
        updatedByUserId: company.adminUserId,
      },
    });
    payrollWorkers.push(created.id);
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

    // Before the run is calculated, because the calculation reads these hours
    // and rule R3 reads them again at submission.
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

    // The ACTIVE guard from the attendance fixture is paid too. Without pay
    // terms they are left out of every run, which left the guard's own payslip
    // untested — every assertion about it sat behind an `if` that was never
    // true.
    await prisma.employeePayTerms.create({
      data: {
        companyId: company.companyId,
        employeeId: company.active.id,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        basicMonthlyPesewas: 160_000,
        overtimeHourlyPesewas: 0,
        createdByUserId: company.adminUserId,
      },
    });
    // And an open employment spell: the calculation pays only the days somebody
    // was employed, and the attendance fixture records no spell of its own.
    await prisma.employmentPeriod.create({
      data: {
        companyId: company.companyId,
        employeeId: company.active.id,
        startsOn: new Date('2026-01-05T00:00:00Z'),
        endsOn: null,
      },
    });
    payrollWorkers.push(company.active.id);
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

  /**
   * Rule R3, the reason this phase exists: a run may not pay for hours the
   * attendance records do not support.
   *
   * Until these tests existed the gate was only ever exercised passing, which
   * is the same as not testing it. Both halves are here: the shift that
   * disappeared after the run was calculated, and the worker who never came at
   * all.
   */
  describe('rule R3: a run cannot pay for hours nobody worked', () => {
    it('refuses a run whose shifts were voided after it was calculated', async () => {
      const { runId } = await draftRun();

      // Somebody disputes the month's attendance after the figures were worked
      // out. The run still says it owes the hours; the records no longer agree.
      await prisma.workSegment.updateMany({
        where: { companyId: company.companyId, employeeId: payrollWorkers[0] },
        data: { status: 'VOIDED', voidedAt: new Date(), voidedByUserId: company.adminUserId },
      });

      const refused = await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(409);
      expect(refused.body.detail).toMatch(/attendance records do not support/);
      // And it names who, so a payroll officer knows where to look.
      expect(refused.body.detail).toMatch(/SMT-7/);
    });

    it('refuses a salaried worker who never came to work at all', async () => {
      // The ghost this whole system is built to stop. Their line has no minutes
      // on either side of the comparison, so a check of minutes against minutes
      // passes it — and basic pay is pro-rated by calendar days, so they are
      // paid a full month (decision 27).
      const ghost = await worker(180_000);
      const { runId } = await draftRun();
      await prisma.workSegment.deleteMany({
        where: { companyId: company.companyId, employeeId: ghost.id },
      });

      const refused = await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(409);
      expect(refused.body.detail).toMatch(new RegExp(ghost.staffNumber));

      // Their record stays; nothing is deleted to make a refusal go away.
      const stillThere = await prisma.payrollLine.findFirst({
        where: { companyId: company.companyId, runId, employeeId: ghost.id },
      });
      expect(stillThere).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  /**
   * A closed month is settled, and the one mistake it prevents is also the one
   * that cannot be undone: a run pushed to LOCKED can never be unlocked.
   */
  describe('a closed month is final', () => {
    /** A month with a draft in it, then closed behind the draft's back. */
    const closedWithADraftLeftBehind = async () => {
      const { periodId, runId } = await draftRun();
      await api()
        .post(`/api/v1/payroll/periods/${periodId}/close`)
        .set(...bearer(token.admin))
        .send({})
        .expect(200);
      return { periodId, runId };
    };

    it('refuses to submit a draft left behind in it', async () => {
      const { runId } = await closedWithADraftLeftBehind();
      const refused = await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(409);
      expect(refused.body.detail).toMatch(/closed/);
    });

    it('refuses to approve or reject a run waiting in it', async () => {
      const { periodId, runId } = await draftRun();
      await api()
        .post(`/api/v1/payroll/runs/${runId}/submit`)
        .set(...bearer(token.hr))
        .send({})
        .expect(200);
      await api()
        .post(`/api/v1/payroll/periods/${periodId}/close`)
        .set(...bearer(token.admin))
        .send({})
        .expect(200);

      await api()
        .post(`/api/v1/payroll/runs/${runId}/approve`)
        .set(...bearer(token.admin))
        .send({})
        .expect(409);
      await api()
        .post(`/api/v1/payroll/runs/${runId}/reject`)
        .set(...bearer(token.admin))
        .send({ reason: 'The month is closed.' })
        .expect(409);

      // Still waiting, and still not locked: the refusal changed nothing.
      const run = await prisma.payrollRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe('PENDING_APPROVAL');
    });
  });

  // -------------------------------------------------------------------------

  describe('a cursor that means nothing', () => {
    it('is a 400 naming the field, on every payroll list', async () => {
      // `decodeCursor` proves only that a value is one of our base64 cursors.
      // `hello|world` decodes perfectly, and the `world` half used to reach the
      // database as a uuid, which answered with a 500 for a plainly bad request.
      const nonsense = Buffer.from('2060-01-01T00:00:00.000Z|world', 'utf8').toString('base64url');
      for (const path of [
        `/api/v1/payroll/runs?cursor=${nonsense}`,
        `/api/v1/payroll/payslips?cursor=${nonsense}`,
      ]) {
        const refused = await api()
          .get(path)
          .set(...bearer(token.hr))
          .expect(400);
        expect(JSON.stringify(refused.body)).toMatch(/cursor/);
      }
    });

    it('does not 500 a lines cursor whose id half is not an id', async () => {
      const { runId } = await draftRun();
      const nonsense = Buffer.from('SMT-7001|world', 'utf8').toString('base64url');
      await api()
        .get(`/api/v1/payroll/runs/${runId}/lines?cursor=${nonsense}`)
        .set(...bearer(token.hr))
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------

  describe('the payslip list and an ID that names nothing', () => {
    it('answers 404, not an empty page', async () => {
      // An empty page says "this month has no payslips"; a 404 says "that is
      // not a month". A payroll officer chasing a missing payslip needs to know
      // which, and both sibling lists already answer this way.
      const nowhere = randomUUID();
      for (const query of [`employeeId=${nowhere}`, `runId=${nowhere}`, `periodId=${nowhere}`]) {
        await api()
          .get(`/api/v1/payroll/payslips?${query}`)
          .set(...bearer(token.hr))
          .expect(404);
      }
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
      // Asserted, not assumed. Both of these used to be `undefined` on every
      // run, so every check below them was skipped and the test proved nothing.
      expect(theirs, 'the guard has a payslip in this run').toBeDefined();
      expect(somebodyElse, 'somebody else has one too').toBeDefined();

      // A guard's list is their own, however they ask.
      const mine = await api()
        .get('/api/v1/payroll/payslips?limit=100')
        .set(...bearer(token.guard))
        .expect(200);
      for (const item of mine.body.items) {
        expect(item.employee.id).toBe(company.active.id);
      }

      await api()
        .get(`/api/v1/payroll/payslips/${theirs.id}`)
        .set(...bearer(token.guard))
        .expect(200);

      // 404 and not 403, so nobody learns which payslips exist.
      await api()
        .get(`/api/v1/payroll/payslips/${somebodyElse.id}`)
        .set(...bearer(token.guard))
        .expect(404);
      await api()
        .get(`/api/v1/payroll/payslips/${somebodyElse.id}/pdf`)
        .set(...bearer(token.guard))
        .expect(404);
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

      // The worker's own account and MoMo number went into the file. Neither
      // may appear in the log, nor may any leading part long enough to narrow
      // it down (decision 25: an account number is short and structured, so a
      // hash of it is the number).
      for (const workerN of ['001', '002']) {
        expect(written).not.toContain(`${PAY_TO.accountNumber.slice(0, -3)}${workerN}`);
      }
      expect(written).not.toContain(PAY_TO.accountNumber.slice(0, 7));
      expect(written).not.toContain(PAY_TO.momoNumber);
      expect(written).not.toContain(PAY_TO.accountName);

      // Only these two keys, so a later change cannot quietly widen it.
      for (const entry of entries) {
        expect(Object.keys(entry.detail as object).sort()).toEqual(['periodId', 'rowCount']);
      }
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
