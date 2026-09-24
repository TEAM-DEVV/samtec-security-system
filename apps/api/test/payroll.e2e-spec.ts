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
 * Payroll setup on a real database (docs/plan/09-payroll-engine-ghana.md): the
 * months, the statutory rates, what each worker is paid, and where the money
 * is sent.
 *
 * These are the endpoints that decide what a payroll run will later calculate
 * from, so the tests here are mostly about the answers that must be refusals:
 * a supervisor who may never see payroll at all, a set of tax bands that would
 * leave the highest earners untaxed, a bank name that a spreadsheet would run
 * as a formula, and a month that can only be closed once.
 *
 * Each run makes its own company, because nothing in payroll may ever be
 * deleted — see `src/modules/payroll/README.md`.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

/** A set of bands that covers every income: the last one has no upper limit. */
const GOOD_BANDS = [
  { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
  { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
  { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 },
];

/** The 2026 rates, as the design page records them. */
const RATES = {
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  sourceName: 'GRA PAYE rates 2026',
  sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
  sourceCheckedOn: '2026-01-05',
};

describe.skipIf(!databaseUrl)('Payroll setup (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let other: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  /** A tax year nothing else in this file has used, so versions never clash. */
  let yearsUsed = 0;
  const freshTaxYear = () => {
    yearsUsed += 1;
    return 2030 + yearsUsed;
  };

  /**
   * A worker nobody else in this file touches.
   *
   * Pay terms and payment details are keyed by employee, so two tests sharing
   * one worker make the second depend on the first having run — and then an
   * `.only`, or a reordering, makes it pass or fail for the wrong reason.
   */
  let workersMade = 0;
  const freshWorker = async (): Promise<string> => {
    workersMade += 1;
    const n = String(workersMade).padStart(3, '0');
    const worker = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-81${n}`,
        firstName: 'Payroll',
        lastName: `Worker ${workersMade}`,
        phone: `+2332081${n}0`,
        ghanaCardNumber: `GHA-81${n}00000-${workersMade % 10}`,
        position: 'Security Guard',
        status: 'ACTIVE',
        hireDate: new Date('2024-01-01T00:00:00Z'),
      },
    });
    return worker.id;
  };

  /** A month nothing else in this file has used. */
  let monthsUsed = 0;
  const freshMonth = () => {
    monthsUsed += 1;
    return { year: 2040 + Math.floor((monthsUsed - 1) / 12), month: ((monthsUsed - 1) % 12) + 1 };
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    other = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    token = await tokensFor(app, company);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe('who may see payroll at all', () => {
    const payrollPaths = ['/api/v1/payroll/periods', '/api/v1/payroll/tax-tables'];

    it('refuses a supervisor everywhere, because a supervisor runs rosters and never money', async () => {
      for (const path of payrollPaths) {
        await api()
          .get(path)
          .set(...bearer(token.supervisor))
          .expect(403);
      }
      await api()
        .get(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.supervisor))
        .expect(403);
    });

    it('refuses a guard their own pay terms and their own payment details', async () => {
      // A guard may read their own payslip, which is a different endpoint. Pay
      // terms and bank details are not theirs to see.
      await api()
        .get(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.guard))
        .expect(403);
      await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.guard))
        .send({ bankName: null, accountName: null, accountNumber: null, momoNumber: null })
        .expect(403);
    });

    it('refuses a payroll officer the tax tables, which only an administrator sets', async () => {
      // The rates decide what every worker in the company is taxed.
      await api()
        .get('/api/v1/payroll/tax-tables')
        .set(...bearer(token.hr))
        .expect(403);
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.hr))
        .send({ taxYear: 2026, effectiveFrom: '2026-01-01', bands: GOOD_BANDS, ...RATES })
        .expect(403);
    });

    it('refuses anybody who is not signed in', async () => {
      await api().get('/api/v1/payroll/periods').expect(401);
    });

    it('lets an administrator do everything a payroll officer can', async () => {
      // Every other test in this file signs in as HR_PAYROLL, so without this
      // an ADMIN could have been locked out of payroll and nothing would say.
      await api()
        .get('/api/v1/payroll/periods')
        .set(...bearer(token.admin))
        .expect(200);
      const month = freshMonth();
      const created = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.admin))
        .send(month)
        .expect(201);
      await api()
        .post(`/api/v1/payroll/periods/${created.body.id}/close`)
        .set(...bearer(token.admin))
        .expect(200);
      const worker = await freshWorker();
      await api()
        .get(`/api/v1/employees/${worker}/pay-terms`)
        .set(...bearer(token.admin))
        .expect(200);
    });
  });

  // -------------------------------------------------------------------------

  describe('the statutory rates', () => {
    it('stores a version with its bands in order, and says where the rates came from', async () => {
      const taxYear = freshTaxYear();
      const created = await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-01-01`,
          // Sent out of order on purpose: the ordinal is what decides the order.
          bands: [GOOD_BANDS[2], GOOD_BANDS[0], GOOD_BANDS[1]],
          ...RATES,
        })
        .expect(201);

      expect(created.headers.location).toBe('/api/v1/payroll/tax-tables');
      expect(created.body.bands.map((band: { ordinal: number }) => band.ordinal)).toEqual([
        1, 2, 3,
      ]);
      expect(created.body.bands[2].widthPesewas).toBeNull();
      expect(created.body.effectiveFrom).toBe(`${taxYear}-01-01`);
      expect(created.body.effectiveTo).toBeNull();
      expect(created.body.sourceName).toBe(RATES.sourceName);
      // A calendar date, never a timestamp.
      expect(created.body.sourceCheckedOn).toBe('2026-01-05');
    });

    it('refuses a table whose highest band has an upper limit', async () => {
      // The failure this guards against is silent: income above the top band
      // would be taxed at nothing, and every payslip would still add up.
      const taxYear = freshTaxYear();
      const refused = await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-01-01`,
          bands: GOOD_BANDS.map((band) => ({
            ...band,
            widthPesewas: band.widthPesewas ?? 200_000,
          })),
          ...RATES,
        })
        .expect(400);

      expect(JSON.stringify(refused.body)).toMatch(/bands/);
      expect(JSON.stringify(refused.body)).toMatch(/no upper limit/);
    });

    it('refuses a gap in the band numbering, and an open band that is not last', async () => {
      const taxYear = freshTaxYear();
      const send = (bands: unknown) =>
        api()
          .post('/api/v1/payroll/tax-tables')
          .set(...bearer(token.admin))
          .send({ taxYear, effectiveFrom: `${taxYear}-01-01`, bands, ...RATES })
          .expect(400);

      await send([GOOD_BANDS[0], { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 }]);
      await send([
        { ordinal: 1, widthPesewas: null, rateBasisPoints: 0 },
        { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
      ]);
    });

    it('refuses tiers that do not add up to what is actually contributed', async () => {
      const taxYear = freshTaxYear();
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-01-01`,
          bands: GOOD_BANDS,
          ...RATES,
          ssnitTier2BasisPoints: 400,
        })
        .expect(400);
    });

    it('refuses rates checked on a day that has not happened yet', async () => {
      const taxYear = freshTaxYear();
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-01-01`,
          bands: GOOD_BANDS,
          ...RATES,
          sourceCheckedOn: '2099-01-01',
        })
        .expect(400);
    });

    it('refuses a version that stops before it starts', async () => {
      const taxYear = freshTaxYear();
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-06-01`,
          effectiveTo: `${taxYear}-01-01`,
          bands: GOOD_BANDS,
          ...RATES,
        })
        .expect(400);
    });

    it('refuses two versions starting on the same day', async () => {
      const taxYear = freshTaxYear();
      const body = {
        taxYear,
        effectiveFrom: `${taxYear}-01-01`,
        bands: GOOD_BANDS,
        ...RATES,
      };
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send(body)
        .expect(201);
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send(body)
        .expect(409);
    });

    it('refuses a field nobody asked for, rather than ignoring it', async () => {
      const taxYear = freshTaxYear();
      await api()
        .post('/api/v1/payroll/tax-tables')
        .set(...bearer(token.admin))
        .send({
          taxYear,
          effectiveFrom: `${taxYear}-01-01`,
          bands: GOOD_BANDS,
          ...RATES,
          ssnitEmployeeBasisPointss: 600,
        })
        .expect(400);
    });

    it('answers which version applied on one day, and nothing else', async () => {
      const taxYear = freshTaxYear();
      for (const month of ['01', '07']) {
        await api()
          .post('/api/v1/payroll/tax-tables')
          .set(...bearer(token.admin))
          .send({
            taxYear,
            effectiveFrom: `${taxYear}-${month}-01`,
            bands: GOOD_BANDS,
            ...RATES,
          })
          .expect(201);
      }

      const inMay = await api()
        .get(`/api/v1/payroll/tax-tables?taxYear=${taxYear}&effectiveOn=${taxYear}-05-15`)
        .set(...bearer(token.admin))
        .expect(200);
      expect(inMay.body.items).toHaveLength(1);
      expect(inMay.body.items[0].effectiveFrom).toBe(`${taxYear}-01-01`);

      const inAugust = await api()
        .get(`/api/v1/payroll/tax-tables?taxYear=${taxYear}&effectiveOn=${taxYear}-08-15`)
        .set(...bearer(token.admin))
        .expect(200);
      expect(inAugust.body.items[0].effectiveFrom).toBe(`${taxYear}-07-01`);

      // Before any version started, there is nothing to answer with.
      const before = await api()
        .get(`/api/v1/payroll/tax-tables?taxYear=${taxYear}&effectiveOn=${taxYear - 1}-12-31`)
        .set(...bearer(token.admin))
        .expect(200);
      expect(before.body.items).toEqual([]);
    });

    it('lists the newest version first', async () => {
      const taxYear = freshTaxYear();
      for (const month of ['01', '04']) {
        await api()
          .post('/api/v1/payroll/tax-tables')
          .set(...bearer(token.admin))
          .send({
            taxYear,
            effectiveFrom: `${taxYear}-${month}-01`,
            bands: GOOD_BANDS,
            ...RATES,
          })
          .expect(201);
      }
      const listed = await api()
        .get(`/api/v1/payroll/tax-tables?taxYear=${taxYear}`)
        .set(...bearer(token.admin))
        .expect(200);
      expect(listed.body.items[0].effectiveFrom).toBe(`${taxYear}-04-01`);
      expect(listed.body.items[1].effectiveFrom).toBe(`${taxYear}-01-01`);
    });
  });

  // -------------------------------------------------------------------------

  describe('a payroll month', () => {
    it('works out its own dates, so a period is always a whole month', async () => {
      const created = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send({ year: 2044, month: 2 })
        .expect(201);

      expect(created.headers.location).toBe('/api/v1/payroll/periods');
      expect(created.body.startDate).toBe('2044-02-01');
      // 2044 is a leap year, so February has 29 days.
      expect(created.body.endDate).toBe('2044-02-29');
      expect(created.body.status).toBe('OPEN');
      expect(created.body.closedAt).toBeNull();
      expect(created.body.lockedRunId).toBeNull();
    });

    it('gets February right in an ordinary year too', async () => {
      const created = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send({ year: 2043, month: 2 })
        .expect(201);
      expect(created.body.endDate).toBe('2043-02-28');
    });

    it('refuses a second period for the same month', async () => {
      const month = freshMonth();
      await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send(month)
        .expect(201);
      await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send(month)
        .expect(409);
    });

    it('tells the loser of a race 409, not 500, when two people open the same month', async () => {
      // The duplicate check is a read followed by a write, so two callers can
      // both pass the read. The unique index then refuses the second write,
      // and without turning that into a 409 it escapes as a 500.
      const month = freshMonth();
      const answers = await Promise.all(
        [0, 1].map(() =>
          api()
            .post('/api/v1/payroll/periods')
            .set(...bearer(token.hr))
            .send(month),
        ),
      );
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('closes a month once, records who closed it, and refuses a second closing', async () => {
      const month = freshMonth();
      const created = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send(month)
        .expect(201);

      const closed = await api()
        .post(`/api/v1/payroll/periods/${created.body.id}/close`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closedAt).not.toBeNull();
      expect(closed.body.closedByUserId).toBe(company.hrUserId);

      await api()
        .post(`/api/v1/payroll/periods/${created.body.id}/close`)
        .set(...bearer(token.hr))
        .expect(409);
    });

    it('answers 404 for another company’s month, not 403', async () => {
      // A 403 would tell somebody the ID exists.
      const theirs = await prisma.payrollPeriod.create({
        data: {
          companyId: other.companyId,
          year: 2045,
          month: 1,
          startsOn: new Date('2045-01-01T00:00:00Z'),
          endsOn: new Date('2045-01-31T00:00:00Z'),
          status: 'OPEN',
        },
      });
      await api()
        .get('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .expect(200)
        .expect((response) => {
          const ids = response.body.items.map((item: { id: string }) => item.id);
          expect(ids).not.toContain(theirs.id);
        });
      await api()
        .post(`/api/v1/payroll/periods/${theirs.id}/close`)
        .set(...bearer(token.hr))
        .expect(404);
    });

    it('filters by status and by year', async () => {
      // Two months of one year, one of them closed, so both filters have
      // something to find and something to leave out.
      const year = 2046;
      const open = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send({ year, month: 3 })
        .expect(201);
      const toClose = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(token.hr))
        .send({ year, month: 4 })
        .expect(201);
      await api()
        .post(`/api/v1/payroll/periods/${toClose.body.id}/close`)
        .set(...bearer(token.hr))
        .expect(200);

      const closed = await api()
        .get(`/api/v1/payroll/periods?status=CLOSED&year=${year}`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(closed.body.items).toHaveLength(1);
      expect(closed.body.items[0].id).toBe(toClose.body.id);

      const stillOpen = await api()
        .get(`/api/v1/payroll/periods?status=OPEN&year=${year}`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(stillOpen.body.items.map((item: { id: string }) => item.id)).toEqual([open.body.id]);
    });

    it('pages through every month exactly once when the cursor is followed', async () => {
      // Nothing anywhere followed a nextCursor, so a cursor that skipped or
      // repeated a page would never have been noticed.
      const year = 2047;
      const made: string[] = [];
      for (let month = 1; month <= 5; month += 1) {
        const period = await api()
          .post('/api/v1/payroll/periods')
          .set(...bearer(token.hr))
          .send({ year, month })
          .expect(201);
        made.push(period.body.id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const page_: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const url: string = `/api/v1/payroll/periods?year=${year}&limit=2${page_}`;
        const answer = await api()
          .get(url)
          .set(...bearer(token.hr))
          .expect(200);
        const body = answer.body as { items: { id: string }[]; nextCursor: string | null };
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      // Newest month first, so the list is the months in reverse.
      expect(seen).toEqual([...made].reverse());
    });

    it('refuses a made-up cursor rather than answering a strange page', async () => {
      await api()
        .get('/api/v1/payroll/periods?cursor=not-a-cursor!!')
        .set(...bearer(token.hr))
        .expect(400);
    });

    it('refuses a cursor that decodes cleanly but holds no date, with 400 and not 500', async () => {
      // `aGVsbG8` is the word "hello" in base64url, so it survives the
      // round-trip check and looks like a real cursor. Before this was caught
      // it became an Invalid Date, and the database refused it with an error
      // carrying no HTTP status — so a bad request answered 500.
      for (const path of [
        '/api/v1/payroll/periods?cursor=aGVsbG8',
        `/api/v1/employees/${company.active.id}/pay-terms?cursor=aGVsbG8`,
      ]) {
        await api()
          .get(path)
          .set(...bearer(token.hr))
          .expect(400);
      }
      await api()
        .get('/api/v1/payroll/tax-tables?cursor=aGVsbG8')
        .set(...bearer(token.admin))
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------

  describe('what a worker is paid', () => {
    const terms = (overrides: Record<string, unknown> = {}) => ({
      effectiveFrom: '2026-01-01',
      basicMonthlyPesewas: 150_000,
      overtimeHourlyPesewas: 900,
      taxableAllowancePesewas: 0,
      nonTaxableAllowancePesewas: 0,
      otherDeductionPesewas: 0,
      ...overrides,
    });

    it('adds a row and never changes the one before it', async () => {
      const first = await api()
        .put(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2026-01-01', basicMonthlyPesewas: 150_000 }))
        .expect(201);
      expect(first.headers.location).toBe(`/api/v1/employees/${company.active.id}/pay-terms`);

      const raise = await api()
        .put(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2026-07-01', basicMonthlyPesewas: 180_000 }))
        .expect(201);
      expect(raise.body.id).not.toBe(first.body.id);

      const history = await api()
        .get(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .expect(200);
      // Newest first, and the older row is untouched.
      expect(history.body.items[0].effectiveFrom).toBe('2026-07-01');
      expect(history.body.items[0].basicMonthlyPesewas).toBe(180_000);
      expect(history.body.items[1].effectiveFrom).toBe('2026-01-01');
      expect(history.body.items[1].basicMonthlyPesewas).toBe(150_000);
    });

    it('answers which row applied on one day, which is what a run asks', async () => {
      const worker = await freshWorker();
      for (const [effectiveFrom, basicMonthlyPesewas] of [
        ['2026-01-01', 150_000],
        ['2026-07-01', 180_000],
      ] as const) {
        await api()
          .put(`/api/v1/employees/${worker}/pay-terms`)
          .set(...bearer(token.hr))
          .send(terms({ effectiveFrom, basicMonthlyPesewas }))
          .expect(201);
      }

      const inMarch = await api()
        .get(`/api/v1/employees/${worker}/pay-terms?effectiveOn=2026-03-15`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(inMarch.body.items).toHaveLength(1);
      expect(inMarch.body.items[0].basicMonthlyPesewas).toBe(150_000);

      const inSeptember = await api()
        .get(`/api/v1/employees/${worker}/pay-terms?effectiveOn=2026-09-15`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(inSeptember.body.items[0].basicMonthlyPesewas).toBe(180_000);

      // A day before any row starts has no answer, rather than the oldest one.
      const tooEarly = await api()
        .get(`/api/v1/employees/${worker}/pay-terms?effectiveOn=2025-12-31`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(tooEarly.body.items).toEqual([]);
    });

    it('refuses two rows starting on the same day', async () => {
      const worker = await freshWorker();
      await api()
        .put(`/api/v1/employees/${worker}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2026-01-01' }))
        .expect(201);
      await api()
        .put(`/api/v1/employees/${worker}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2026-01-01', basicMonthlyPesewas: 999_999 }))
        .expect(409);
    });

    it('refuses pay above the cap, so a line total can never overflow', async () => {
      await api()
        .put(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2027-01-01', basicMonthlyPesewas: 2_000_000_000 }))
        .expect(400);
    });

    it('refuses a partly filled body, because a missing field would become zero', async () => {
      await api()
        .put(`/api/v1/employees/${company.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .send({ effectiveFrom: '2027-02-01', basicMonthlyPesewas: 150_000 })
        .expect(400);
    });

    it('answers 404 for a worker of another company', async () => {
      await api()
        .get(`/api/v1/employees/${other.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .expect(404);
      await api()
        .put(`/api/v1/employees/${other.active.id}/pay-terms`)
        .set(...bearer(token.hr))
        .send(terms({ effectiveFrom: '2028-01-01' }))
        .expect(404);
    });

    it('answers an empty list for a worker with no pay terms yet', async () => {
      const empty = await api()
        .get(`/api/v1/employees/${company.suspended.id}/pay-terms`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(empty.body).toEqual({ items: [], nextCursor: null });
    });
  });

  // -------------------------------------------------------------------------

  describe('where the money is sent', () => {
    const details = (overrides: Record<string, unknown> = {}) => ({
      bankName: 'Akwaaba Bank',
      accountName: 'Test Worker',
      accountNumber: '1234567890',
      momoNumber: null,
      ...overrides,
    });

    it('stores the destination and forbids any copy being kept', async () => {
      const saved = await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details())
        .expect(200);

      // Personal data, so no browser or proxy may cache the answer.
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(saved.body.accountNumber).toBe('1234567890');
      expect(saved.body.updatedByUserId).toBe(company.hrUserId);
    });

    it('replaces the destination in place, because only the latest one matters', async () => {
      const worker = await freshWorker();
      await api()
        .put(`/api/v1/employees/${worker}/payment-details`)
        .set(...bearer(token.hr))
        .send(details())
        .expect(200);

      const changed = await api()
        .put(`/api/v1/employees/${worker}/payment-details`)
        .set(...bearer(token.hr))
        .send(
          details({
            bankName: null,
            accountName: null,
            accountNumber: null,
            momoNumber: '+233241234567',
          }),
        )
        .expect(200);
      // Every field is replaced, not merged: sending null really does clear it.
      expect(changed.body.bankName).toBeNull();
      expect(changed.body.accountName).toBeNull();
      expect(changed.body.accountNumber).toBeNull();
      expect(changed.body.momoNumber).toBe('+233241234567');
    });

    it('refuses a bank name a spreadsheet would run as a formula', async () => {
      // Decision 23: this value is written straight into the bank file.
      for (const bankName of ['=1+1', '+1', '-1', '@SUM(A1)', '"Bank']) {
        await api()
          .put(`/api/v1/employees/${company.active.id}/payment-details`)
          .set(...bearer(token.hr))
          .send(details({ bankName }))
          .expect(400);
      }
    });

    it('refuses a formula hiding behind a leading space', async () => {
      // A spreadsheet trims the space away on import and runs what follows.
      await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details({ accountName: ' =1+1+cmd|calc' }))
        .expect(400);
    });

    it('refuses any leading space at all, and does not quietly trim it away', async () => {
      // This is the case the previous test misses: after a trim, ' =1+1' still
      // starts with '=' and is refused for that reason instead. A plain name
      // behind a space proves the space itself is what is refused — which it
      // must be, because the contract, the dashboard mock and the database
      // CHECK all refuse it, and the API cannot be the one place that does not.
      for (const value of [' Akwaaba Bank', '\tAkwaaba Bank']) {
        await api()
          .put(`/api/v1/employees/${company.active.id}/payment-details`)
          .set(...bearer(token.hr))
          .send(details({ bankName: value }))
          .expect(400);
      }
    });

    it('refuses an invisible control character, which the database cannot store', async () => {
      // PostgreSQL cannot hold a NUL byte in a text column at all, so without
      // this the answer would be a 500 from deep in the driver.
      await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details({ accountName: 'Kwame\u0000 Mensah' }))
        .expect(400);
    });

    it('refuses a name holding a line break, which would forge a bank file row', async () => {
      await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details({ accountName: 'Real Name\r\nSMT-00099,Somebody Else' }))
        .expect(400);
    });

    it('refuses an account number that is not digits, and names the field without quoting it', async () => {
      const refused = await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details({ accountNumber: '12-34-56' }))
        .expect(400);
      expect(JSON.stringify(refused.body)).toMatch(/accountNumber/);
      // The rejected value itself is never echoed back.
      expect(JSON.stringify(refused.body)).not.toMatch(/12-34-56/);
    });

    it('records that the destination changed, and never what it changed to', async () => {
      const uniqueNumber = '9876500001';
      await api()
        .put(`/api/v1/employees/${company.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details({ accountNumber: uniqueNumber }))
        .expect(200);

      const entries = await prisma.auditLog.findMany({
        where: { companyId: company.companyId, action: { startsWith: 'payroll.payment_details' } },
      });
      expect(entries.length).toBeGreaterThan(0);
      const written = JSON.stringify(entries);
      // Not the number, not a hash of it: a twenty-digit number's hash can be
      // worked backwards in minutes, so storing one would be storing the number.
      expect(written).not.toMatch(new RegExp(uniqueNumber));
      expect(written).not.toMatch(/Akwaaba/);
      expect(written).toMatch(/bankAccountChanged/);
    });

    it('answers 404 for a worker of another company', async () => {
      await api()
        .put(`/api/v1/employees/${other.active.id}/payment-details`)
        .set(...bearer(token.hr))
        .send(details())
        .expect(404);
    });
  });
});
