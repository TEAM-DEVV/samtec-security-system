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
 * Calculating a month's pay against a real database
 * (docs/plan/09-payroll-engine-ghana.md).
 *
 * The figures here are hand-checkable on purpose. A test that only asserts
 * "a run was created" would pass while paying everybody the wrong amount, so
 * each case states what one worker should be paid and why, and the arithmetic
 * is small enough to follow with a calculator.
 *
 * Each run makes its own company, because nothing in payroll may ever be
 * deleted — see `src/modules/payroll/README.md`.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

/** The 2026 rates from the design page, shortened to the bands these tests reach. */
const RATES = {
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  sourceName: 'GRA PAYE rates 2026',
  sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
  sourceCheckedOn: '2026-01-05',
};

/** The full 2026 band table, so the golden figures match the design page. */
const BANDS = [
  { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
  { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
  { ordinal: 3, widthPesewas: 50_000, rateBasisPoints: 1000 },
  { ordinal: 4, widthPesewas: 200_000, rateBasisPoints: 1750 },
  { ordinal: 5, widthPesewas: 200_000, rateBasisPoints: 2500 },
  { ordinal: 6, widthPesewas: 1_491_000, rateBasisPoints: 3000 },
  { ordinal: 7, widthPesewas: null, rateBasisPoints: 3500 },
];

describe.skipIf(!databaseUrl)('Calculating a payroll run (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let other: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  let workersMade = 0;
  /** A worker of this test's own, with pay terms unless told otherwise. */
  const worker = async (
    options: {
      basicMonthlyPesewas?: number;
      overtimeHourlyPesewas?: number;
      otherDeductionPesewas?: number;
      status?: 'ACTIVE' | 'SUSPENDED';
      hiredOn?: string;
      leftOn?: string | null;
      payTerms?: boolean;
    } = {},
  ) => {
    workersMade += 1;
    const n = String(workersMade).padStart(3, '0');
    const hiredOn = new Date(`${options.hiredOn ?? '2024-01-01'}T00:00:00Z`);
    const created = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-9${n}`,
        firstName: 'Run',
        lastName: `Worker ${workersMade}`,
        phone: `+2332090${n}0`,
        ghanaCardNumber: `GHA-90${n}00000-${workersMade % 10}`,
        position: 'Security Guard',
        status: options.status ?? 'ACTIVE',
        hireDate: hiredOn,
      },
    });
    await prisma.employmentPeriod.create({
      data: {
        companyId: company.companyId,
        employeeId: created.id,
        startsOn: hiredOn,
        endsOn:
          options.leftOn === undefined || options.leftOn === null
            ? null
            : new Date(`${options.leftOn}T00:00:00Z`),
      },
    });
    if (options.payTerms !== false) {
      await prisma.employeePayTerms.create({
        data: {
          companyId: company.companyId,
          employeeId: created.id,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          basicMonthlyPesewas: options.basicMonthlyPesewas ?? 150_000,
          overtimeHourlyPesewas: options.overtimeHourlyPesewas ?? 0,
          otherDeductionPesewas: options.otherDeductionPesewas ?? 0,
          createdByUserId: company.adminUserId,
        },
      });
    }
    return { id: created.id, staffNumber: created.staffNumber };
  };

  /**
   * A confirmed shift on one date.
   *
   * `MANUAL` because a segment that was not manual must name the two punches it
   * was paired from, and a database CHECK insists on it. A supervisor adding a
   * shift by hand is a real case, and it saves inventing punch rows that these
   * tests never look at.
   */
  const shift = (employeeId: string, workDate: string, workedMinutes: number) => {
    const startedAt = new Date(`${workDate}T06:00:00Z`);
    return prisma.workSegment.create({
      data: {
        companyId: company.companyId,
        employeeId,
        siteId: company.siteA,
        workDate: new Date(`${workDate}T00:00:00Z`),
        startedAt,
        endedAt: new Date(startedAt.getTime() + workedMinutes * 60_000),
        workedMinutes,
        basis: 'MANUAL',
        status: 'CONFIRMED',
      },
    });
  };

  let monthsUsed = 0;
  /** An open month of this test's own, with a tax table covering it. */
  const monthWithRates = async () => {
    monthsUsed += 1;
    const year = 2050 + Math.floor((monthsUsed - 1) / 12);
    const month = ((monthsUsed - 1) % 12) + 1;
    const existing = await prisma.taxTable.findFirst({
      where: { companyId: company.companyId, taxYear: year },
    });
    if (existing === null) {
      await prisma.taxTable.create({
        data: {
          companyId: company.companyId,
          taxYear: year,
          effectiveFrom: new Date(Date.UTC(year, 0, 1)),
          ...RATES,
          sourceCheckedOn: new Date('2026-01-05T00:00:00Z'),
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
    return {
      id: period.body.id as string,
      startDate: period.body.startDate as string,
      endDate: period.body.endDate as string,
      days: Number(period.body.endDate.slice(8)),
    };
  };

  const calculate = (periodId: string) =>
    api()
      .post('/api/v1/payroll/runs')
      .set(...bearer(token.hr))
      .send({ periodId });

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

  describe('the money, worked out from the company’s own records', () => {
    it('pays a whole month at the figures the design page hand-calculated', async () => {
      const period = await monthWithRates();
      const paid = await worker({ basicMonthlyPesewas: 200_000 });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${paid.id}`)
        .set(...bearer(token.hr))
        .expect(200);

      const line = lines.body.items[0];
      // Golden payslip 2: basic GHS 2,000 for a whole month.
      expect(line.basicPesewas).toBe(200_000);
      expect(line.grossPesewas).toBe(200_000);
      // 5.5% of 200,000.
      expect(line.ssnitEmployeePesewas).toBe(11_000);
      expect(line.chargeableIncomePesewas).toBe(189_000);
      // 0 + 500 + 5,000 + 14,000 across the first four bands.
      expect(line.payePesewas).toBe(19_500);
      expect(line.netPayPesewas).toBe(169_500);
      // Nothing was worked, and that never reduces the basic (decision 4).
      expect(line.punchedMinutes).toBe(0);
      expect(line.overtimeMinutes).toBe(0);
    });

    it('pro-rates the basic by calendar days employed, and nothing else', async () => {
      const period = await monthWithRates();
      // Joined halfway through a 30-day month.
      const joiner = await worker({
        basicMonthlyPesewas: 150_000,
        hiredOn: `${period.startDate.slice(0, 8)}16`,
      });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${joiner.id}`)
        .set(...bearer(token.hr))
        .expect(200);

      const line = lines.body.items[0];
      expect(line.daysInPeriod).toBe(period.days);
      // The 16th to the last day, both counted.
      expect(line.daysEmployed).toBe(period.days - 15);
      expect(line.basicPesewas).toBe(Math.round((150_000 * (period.days - 15)) / period.days));
    });

    it('pays overtime for the minutes past each day’s scheduled shift', async () => {
      const period = await monthWithRates();
      // GHS 9.00 an hour of overtime.
      const busy = await worker({ basicMonthlyPesewas: 150_000, overtimeHourlyPesewas: 900 });
      // Two ten-hour days against the standard eight: four hours of overtime.
      await shift(busy.id, `${period.startDate.slice(0, 8)}02`, 600);
      await shift(busy.id, `${period.startDate.slice(0, 8)}03`, 600);
      // And one short day, which must not create negative overtime.
      await shift(busy.id, `${period.startDate.slice(0, 8)}04`, 300);

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${busy.id}`)
        .set(...bearer(token.hr))
        .expect(200);

      const line = lines.body.items[0];
      expect(line.punchedMinutes).toBe(1_500);
      expect(line.overtimeMinutes).toBe(240);
      expect(line.regularMinutes).toBe(1_260);
      // Four hours at GHS 9.00.
      expect(line.overtimePesewas).toBe(3_600);
      expect(line.grossPesewas).toBe(line.basicPesewas + 3_600);
    });

    it('counts a disputed or voided shift as no hours at all', async () => {
      const period = await monthWithRates();
      const argued = await worker({ basicMonthlyPesewas: 150_000, overtimeHourlyPesewas: 900 });
      const day = `${period.startDate.slice(0, 8)}05`;
      await prisma.workSegment.create({
        data: {
          companyId: company.companyId,
          employeeId: argued.id,
          siteId: company.siteA,
          workDate: new Date(`${day}T00:00:00Z`),
          startedAt: new Date(`${day}T06:00:00Z`),
          endedAt: new Date(`${day}T22:00:00Z`),
          workedMinutes: 960,
          basis: 'MANUAL',
          status: 'DISPUTED',
        },
      });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${argued.id}`)
        .set(...bearer(token.hr))
        .expect(200);

      // A shift still being argued about pays nothing until somebody settles it.
      expect(lines.body.items[0].punchedMinutes).toBe(0);
      expect(lines.body.items[0].overtimePesewas).toBe(0);
    });

    it('can pay a negative net when a monthly deduction outruns a part month', async () => {
      const period = await monthWithRates();
      // Joined on the last day, with a whole month's loan instalment due.
      const lastDay = period.endDate;
      const late = await worker({
        basicMonthlyPesewas: 150_000,
        otherDeductionPesewas: 20_000,
        hiredOn: lastDay,
      });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${late.id}`)
        .set(...bearer(token.hr))
        .expect(200);

      const line = lines.body.items[0];
      expect(line.daysEmployed).toBe(1);
      expect(line.otherDeductionsPesewas).toBe(20_000);
      // A stated limitation of decision 24: deductions are not pro-rated.
      expect(line.netPayPesewas).toBeLessThan(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('who is left out, and said to be left out', () => {
    it('names a suspended worker rather than forgetting them', async () => {
      const period = await monthWithRates();
      const suspended = await worker({ status: 'SUSPENDED' });

      const run = await calculate(period.id).expect(201);
      const excluded = run.body.summary.excluded as {
        employee: { id: string };
        reason: string;
      }[];
      const named = excluded.find((entry) => entry.employee.id === suspended.id);
      expect(named?.reason).toBe('SUSPENDED');

      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${suspended.id}`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(lines.body.items).toEqual([]);
    });

    it('names a worker with no pay terms, because nobody can guess their salary', async () => {
      const period = await monthWithRates();
      const unpriced = await worker({ payTerms: false });

      const run = await calculate(period.id).expect(201);
      const excluded = run.body.summary.excluded as {
        employee: { id: string; staffNumber: string };
        reason: string;
      }[];
      const named = excluded.find((entry) => entry.employee.id === unpriced.id);
      expect(named?.reason).toBe('NO_PAY_TERMS');
      // The staff number is there so a payroll officer knows who to chase.
      expect(named?.employee.staffNumber).toBe(unpriced.staffNumber);
    });

    it('leaves out somebody who had already left before the month began', async () => {
      const period = await monthWithRates();
      const gone = await worker({ hiredOn: '2024-01-01', leftOn: '2024-06-30' });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?employeeId=${gone.id}`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(lines.body.items).toEqual([]);
      // Not an exclusion either: they are simply not this month's business.
      const excluded = run.body.summary.excluded as { employee: { id: string } }[];
      expect(excluded.map((entry) => entry.employee.id)).not.toContain(gone.id);
    });
  });

  // -------------------------------------------------------------------------

  describe('the run itself', () => {
    it('adds up: the totals are the exact sums of the lines', async () => {
      const period = await monthWithRates();
      await worker({ basicMonthlyPesewas: 120_000 });
      await worker({ basicMonthlyPesewas: 450_000 });

      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines?limit=100`)
        .set(...bearer(token.hr))
        .expect(200);

      const sum = (field: string) =>
        (lines.body.items as Record<string, number>[]).reduce(
          (running, line) => running + (line[field] ?? 0),
          0,
        );
      expect(run.body.totals.totalGrossPesewas).toBe(sum('grossPesewas'));
      expect(run.body.totals.totalNetPayPesewas).toBe(sum('netPayPesewas'));
      expect(run.body.totals.totalPayePesewas).toBe(sum('payePesewas'));
      expect(run.body.summary.lineCount).toBe(lines.body.items.length);
      expect(run.body.summary.adjustmentLineCount).toBe(0);
    });

    it('records the caller as the maker, which is what stops them approving it', async () => {
      const period = await monthWithRates();
      const run = await calculate(period.id).expect(201);
      expect(run.body.calculatedByUserId).toBe(company.hrUserId);
      expect(run.body.status).toBe('DRAFT');
      expect(run.body.submittedAt).toBeNull();
      expect(run.body.approvedAt).toBeNull();
    });

    it('makes another draft when asked again, and never changes the first', async () => {
      const period = await monthWithRates();
      await worker({ basicMonthlyPesewas: 150_000 });

      const first = await calculate(period.id).expect(201);
      const second = await calculate(period.id).expect(201);
      expect(second.body.id).not.toBe(first.body.id);

      const again = await api()
        .get(`/api/v1/payroll/runs/${first.body.id}`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(again.body.totals).toEqual(first.body.totals);
      expect(again.body.calculatedAt).toBe(first.body.calculatedAt);
    });

    it('answers a Location header and the run at that address', async () => {
      const period = await monthWithRates();
      const run = await calculate(period.id).expect(201);
      expect(run.headers.location).toBe(`/api/v1/payroll/runs/${run.body.id}`);
      await api()
        .get(run.headers.location as string)
        .set(...bearer(token.hr))
        .expect(200);
    });

    it('refuses a run for a month that is closed', async () => {
      const period = await monthWithRates();
      await api()
        .post(`/api/v1/payroll/periods/${period.id}/close`)
        .set(...bearer(token.hr))
        .expect(200);
      await calculate(period.id).expect(409);
    });

    it('refuses a run for a month no version of the rates covers', async () => {
      // A company with no tax table at all cannot be paid.
      const bare = await createAttendanceCompany(prisma);
      const bareToken = await tokensFor(app, bare);
      const period = await api()
        .post('/api/v1/payroll/periods')
        .set(...bearer(bareToken.hr))
        .send({ year: 2049, month: 1 })
        .expect(201);
      await api()
        .post('/api/v1/payroll/runs')
        .set(...bearer(bareToken.hr))
        .send({ periodId: period.body.id })
        .expect(409);
    });

    it('answers 404 for a month, or a run, of another company', async () => {
      const theirs = await prisma.payrollPeriod.create({
        data: {
          companyId: other.companyId,
          year: 2048,
          month: 1,
          startsOn: new Date('2048-01-01T00:00:00Z'),
          endsOn: new Date('2048-01-31T00:00:00Z'),
          status: 'OPEN',
        },
      });
      await calculate(theirs.id).expect(404);
      await api()
        .get(`/api/v1/payroll/runs/${randomUUID()}`)
        .set(...bearer(token.hr))
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('reading a run back', () => {
    it('forbids a copy of the lines being kept, because they are everybody’s pay', async () => {
      const period = await monthWithRates();
      const run = await calculate(period.id).expect(201);
      const lines = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/lines`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(lines.headers['cache-control']).toBe('no-store');
    });

    it('sorts the lines by staff number and pages through them once each', async () => {
      const period = await monthWithRates();
      for (let index = 0; index < 5; index += 1) {
        await worker({ basicMonthlyPesewas: 120_000 });
      }
      const run = await calculate(period.id).expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const url: string = `/api/v1/payroll/runs/${run.body.id}/lines?limit=2${suffix}`;
        const answer = await api()
          .get(url)
          .set(...bearer(token.hr))
          .expect(200);
        const body = answer.body as {
          items: { employee: { staffNumber: string } }[];
          nextCursor: string | null;
        };
        seen.push(...body.items.map((line) => line.employee.staffNumber));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...seen].sort());
    });

    it('reports statutory totals that tie, with the rates they were worked out at', async () => {
      const period = await monthWithRates();
      // A basic that divides awkwardly, so a tier split that did not reconcile
      // would show up here.
      await worker({ basicMonthlyPesewas: 120_019 });

      const run = await calculate(period.id).expect(201);
      const summary = await api()
        .get(`/api/v1/payroll/runs/${run.body.id}/statutory-summary`)
        .set(...bearer(token.hr))
        .expect(200);

      const body = summary.body;
      expect(body.ssnitEmployeeBasisPoints).toBe(550);
      expect(body.ssnitEmployerBasisPoints).toBe(1300);
      expect(body.totalSsnitPesewas).toBe(
        body.totalSsnitEmployeePesewas + body.totalSsnitEmployerPesewas,
      );
      // The two tiers are a split of that same total (decision 26).
      expect(body.totalSsnitTier1Pesewas + body.totalSsnitTier2Pesewas).toBe(
        body.totalSsnitPesewas,
      );
    });

    it('filters the run list by month and by status', async () => {
      const period = await monthWithRates();
      const run = await calculate(period.id).expect(201);
      const listed = await api()
        .get(`/api/v1/payroll/runs?periodId=${period.id}&status=DRAFT`)
        .set(...bearer(token.hr))
        .expect(200);
      expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(run.body.id);
      for (const item of listed.body.items) {
        expect(item.status).toBe('DRAFT');
        expect(item.periodId).toBe(period.id);
      }
    });

    it('refuses a cursor it cannot use, rather than answering a strange page', async () => {
      for (const path of [
        '/api/v1/payroll/runs?cursor=aGVsbG8',
        '/api/v1/payroll/runs?cursor=not-a-cursor!!',
      ]) {
        await api()
          .get(path)
          .set(...bearer(token.hr))
          .expect(400);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('who may calculate pay', () => {
    it('refuses a supervisor and a guard everywhere', async () => {
      const period = await monthWithRates();
      for (const who of [token.supervisor, token.guard]) {
        await api()
          .get('/api/v1/payroll/runs')
          .set(...bearer(who))
          .expect(403);
        await api()
          .post('/api/v1/payroll/runs')
          .set(...bearer(who))
          .send({ periodId: period.id })
          .expect(403);
      }
    });

    it('lets an administrator calculate, as well as a payroll officer', async () => {
      const period = await monthWithRates();
      const run = await api()
        .post('/api/v1/payroll/runs')
        .set(...bearer(token.admin))
        .send({ periodId: period.id })
        .expect(201);
      expect(run.body.calculatedByUserId).toBe(company.adminUserId);
    });
  });
});
