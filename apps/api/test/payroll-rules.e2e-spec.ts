import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The payroll rules the **database itself** enforces, against a real
 * PostgreSQL — not the service, not a mock. Payroll moves real money, so the
 * controls that matter are written into the schema as CHECK constraints and
 * triggers: a bug in the service, or somebody with a database client, still
 * cannot write pay that does not add up, change a run after it was approved,
 * or approve their own work.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, "the rules the database must
 * enforce", plus decisions 12, 16, 17, 20, 22, 23 and 24.
 *
 * These run when TEST_DATABASE_URL points at a migrated database:
 *
 * - Locally: start the database (`pnpm db:start`), then
 *   `TEST_DATABASE_URL=postgresql://samtec:samtec-local-only@localhost:54329/samtec_dev pnpm --filter @samtec/api test`
 * - In CI: the `database` job runs them against its PostgreSQL service.
 *
 * Each run makes its own company, because nothing in payroll may ever be
 * deleted — that is one of the rules being proved.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('The payroll rules the database enforces (e2e)', () => {
  let prisma: PrismaClient;

  const companyId = randomUUID();
  const employeeId = randomUUID();
  const otherEmployeeId = randomUUID();
  const taxTableId = randomUUID();
  const periodId = randomUUID();
  const payTermsId = randomUUID();
  const maker = randomUUID();
  const checker = randomUUID();

  /** A line that adds up, which each test then breaks in exactly one way. */
  const soundLine = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId,
    runId: '',
    employeeId,
    staffNumber: 'SMT-70001',
    fullName: 'Test Worker',
    employeeStatus: 'ACTIVE' as const,
    payTermsId,
    payTermsEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
    basicMonthlyPesewas: 200_000,
    overtimeHourlyPesewas: 900,
    daysInPeriod: 30,
    daysEmployed: 30,
    scheduledMinutes: 15_840,
    punchedMinutes: 15_840,
    regularMinutes: 15_840,
    overtimeMinutes: 0,
    basicPesewas: 200_000,
    overtimePesewas: 0,
    taxableAllowancePesewas: 0,
    nonTaxableAllowancePesewas: 0,
    grossPesewas: 200_000,
    taxableGrossPesewas: 200_000,
    ssnitEmployeePesewas: 11_000,
    ssnitEmployerPesewas: 26_000,
    ssnitTier1Pesewas: 27_000,
    ssnitTier2Pesewas: 10_000,
    chargeableIncomePesewas: 189_000,
    payePesewas: 19_500,
    otherDeductionsPesewas: 0,
    netPayPesewas: 169_500,
    taxTableId,
    taxYear: 2026,
    ...overrides,
  });

  const draftRun = async () =>
    prisma.payrollRun.create({
      data: {
        id: randomUUID(),
        companyId,
        periodId,
        taxTableId,
        status: 'DRAFT',
        calculatedByUserId: maker,
        excludedEmployees: [],
      },
    });

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl ?? '');
    await prisma.company.create({ data: { id: companyId, name: 'Payroll Rules Test' } });
    for (const [id, staffNumber, index] of [
      [employeeId, 'SMT-70001', 1],
      [otherEmployeeId, 'SMT-70002', 2],
    ] as const) {
      await prisma.employee.create({
        data: {
          id,
          companyId,
          staffNumber,
          firstName: 'Test',
          lastName: `Worker ${index}`,
          phone: `+23320700000${index}`,
          ghanaCardNumber: `GHA-70000000${index}-${index}`,
          position: 'Security Guard',
          status: 'ACTIVE',
          hireDate: new Date('2024-01-01T00:00:00Z'),
        },
      });
    }
    await prisma.taxTable.create({
      data: {
        id: taxTableId,
        companyId,
        taxYear: 2026,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        ssnitEmployeeBasisPoints: 550,
        ssnitEmployerBasisPoints: 1300,
        ssnitTier1BasisPoints: 1350,
        ssnitTier2BasisPoints: 500,
        sourceName: 'GRA PAYE rates 2026',
        sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
        sourceCheckedOn: new Date('2026-01-05T00:00:00Z'),
        createdByUserId: maker,
        bands: {
          create: [
            { id: randomUUID(), companyId, ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
            { id: randomUUID(), companyId, ordinal: 2, widthPesewas: null, rateBasisPoints: 2500 },
          ],
        },
      },
    });
    await prisma.payrollPeriod.create({
      data: {
        id: periodId,
        companyId,
        year: 2026,
        month: 9,
        startsOn: new Date('2026-09-01T00:00:00Z'),
        endsOn: new Date('2026-09-30T00:00:00Z'),
        status: 'OPEN',
      },
    });
    await prisma.employeePayTerms.create({
      data: {
        id: payTermsId,
        companyId,
        employeeId,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        basicMonthlyPesewas: 200_000,
        overtimeHourlyPesewas: 900,
        createdByUserId: maker,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('a month is a whole month, closed once and never reopened', () => {
    it('refuses a period that is not a whole calendar month', async () => {
      await expect(
        prisma.payrollPeriod.create({
          data: {
            companyId,
            year: 2026,
            month: 10,
            startsOn: new Date('2026-10-05T00:00:00Z'),
            endsOn: new Date('2026-10-20T00:00:00Z'),
            status: 'OPEN',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a closed month that does not say who closed it', async () => {
      const period = await prisma.payrollPeriod.create({
        data: {
          companyId,
          year: 2027,
          month: 1,
          startsOn: new Date('2027-01-01T00:00:00Z'),
          endsOn: new Date('2027-01-31T00:00:00Z'),
          status: 'OPEN',
        },
      });
      await expect(
        prisma.payrollPeriod.update({
          where: { id: period.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('closes a month once, and never lets it reopen', async () => {
      const period = await prisma.payrollPeriod.create({
        data: {
          companyId,
          year: 2027,
          month: 2,
          startsOn: new Date('2027-02-01T00:00:00Z'),
          endsOn: new Date('2027-02-28T00:00:00Z'),
          status: 'OPEN',
        },
      });
      const closed = await prisma.payrollPeriod.update({
        where: { id: period.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: maker },
      });
      expect(closed.status).toBe('CLOSED');

      await expect(
        prisma.payrollPeriod.update({
          where: { id: period.id },
          data: { status: 'OPEN', closedAt: null, closedByUserId: null },
        }),
      ).rejects.toThrow();
    });

    it('never lets a period be deleted', async () => {
      await expect(prisma.payrollPeriod.delete({ where: { id: periodId } })).rejects.toThrow();
    });
  });

  describe('the statutory rates are frozen once a run has used them', () => {
    it('refuses to change a table a payroll run refers to', async () => {
      await draftRun();
      await expect(
        prisma.taxTable.update({
          where: { id: taxTableId },
          data: { ssnitEmployeeBasisPoints: 600 },
        }),
      ).rejects.toThrow();
    });

    it('refuses a table whose last band has a width, which would untax the highest earners', async () => {
      await expect(
        prisma.taxTable.create({
          data: {
            companyId,
            taxYear: 2028,
            effectiveFrom: new Date('2028-01-01T00:00:00Z'),
            ssnitEmployeeBasisPoints: 550,
            ssnitEmployerBasisPoints: 1300,
            ssnitTier1BasisPoints: 1350,
            ssnitTier2BasisPoints: 500,
            sourceName: 'A table with no open top band',
            sourceUrl: 'https://gra.gov.gh',
            sourceCheckedOn: new Date('2027-12-01T00:00:00Z'),
            createdByUserId: maker,
            bands: {
              create: [
                { companyId, ordinal: 1, widthPesewas: 50_000, rateBasisPoints: 0 },
                { companyId, ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 3000 },
              ],
            },
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a table whose band ordinals have a gap', async () => {
      await expect(
        prisma.taxTable.create({
          data: {
            companyId,
            taxYear: 2029,
            effectiveFrom: new Date('2029-01-01T00:00:00Z'),
            ssnitEmployeeBasisPoints: 550,
            ssnitEmployerBasisPoints: 1300,
            ssnitTier1BasisPoints: 1350,
            ssnitTier2BasisPoints: 500,
            sourceName: 'A table with a gap',
            sourceUrl: 'https://gra.gov.gh',
            sourceCheckedOn: new Date('2028-12-01T00:00:00Z'),
            createdByUserId: maker,
            bands: {
              create: [
                { companyId, ordinal: 1, widthPesewas: 50_000, rateBasisPoints: 0 },
                { companyId, ordinal: 5, widthPesewas: null, rateBasisPoints: 3000 },
              ],
            },
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('pay terms are history, and payment details are the money s destination', () => {
    it('refuses to edit a pay terms row: a change in pay is a new row', async () => {
      await expect(
        prisma.employeePayTerms.update({
          where: { id: payTermsId },
          data: { basicMonthlyPesewas: 999_999 },
        }),
      ).rejects.toThrow();
    });

    it('refuses an account name a spreadsheet would run as a formula', async () => {
      await expect(
        prisma.employeePaymentDetails.create({
          data: {
            companyId,
            employeeId,
            accountName: '=HYPERLINK("http://example.invalid")',
            updatedByUserId: maker,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an account name holding a line break, which would forge a bank file row', async () => {
      await expect(
        prisma.employeePaymentDetails.create({
          data: {
            companyId,
            employeeId: otherEmployeeId,
            accountName: 'Kwame\nMensah',
            updatedByUserId: maker,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('a payroll line always adds up', () => {
    it('accepts a line whose parts add up to its totals', async () => {
      const run = await draftRun();
      const line = await prisma.payrollLine.create({ data: soundLine({ runId: run.id }) });
      expect(line.netPayPesewas).toBe(
        line.grossPesewas -
          line.ssnitEmployeePesewas -
          line.payePesewas -
          line.otherDeductionsPesewas,
      );
    });

    it('refuses a line whose net pay does not add up', async () => {
      const run = await draftRun();
      await expect(
        prisma.payrollLine.create({ data: soundLine({ runId: run.id, netPayPesewas: 169_501 }) }),
      ).rejects.toThrow();
    });

    it('refuses a line whose gross is not the sum of its parts', async () => {
      const run = await draftRun();
      await expect(
        prisma.payrollLine.create({ data: soundLine({ runId: run.id, grossPesewas: 200_001 }) }),
      ).rejects.toThrow();
    });

    it('refuses a line claiming more days employed than the period has', async () => {
      const run = await draftRun();
      await expect(
        prisma.payrollLine.create({ data: soundLine({ runId: run.id, daysEmployed: 31 }) }),
      ).rejects.toThrow();
    });

    it('refuses a second ordinary line for the same person on one run', async () => {
      const run = await draftRun();
      await prisma.payrollLine.create({ data: soundLine({ runId: run.id }) });
      await expect(
        prisma.payrollLine.create({ data: soundLine({ runId: run.id }) }),
      ).rejects.toThrow();
    });
  });

  describe('the maker is never the checker, and a locked run never changes', () => {
    async function submitted() {
      const run = await draftRun();
      await prisma.payrollLine.create({ data: soundLine({ runId: run.id }) });
      return prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'PENDING_APPROVAL', submittedByUserId: maker, submittedAt: new Date() },
      });
    }

    it('refuses the person who submitted a run approving it', async () => {
      const run = await submitted();
      await expect(
        prisma.payrollRun.update({
          where: { id: run.id },
          data: { status: 'LOCKED', approvedByUserId: maker, approvedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('refuses the person who calculated a run approving it, even if somebody else submitted', async () => {
      const run = await draftRun();
      await prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'PENDING_APPROVAL', submittedByUserId: checker, submittedAt: new Date() },
      });
      await expect(
        prisma.payrollRun.update({
          where: { id: run.id },
          data: { status: 'LOCKED', approvedByUserId: maker, approvedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('lets a different person approve, and then refuses every later change', async () => {
      const run = await submitted();
      const locked = await prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'LOCKED', approvedByUserId: checker, approvedAt: new Date() },
      });
      expect(locked.status).toBe('LOCKED');

      // The pay is settled: neither the run nor its lines can move again.
      await expect(
        prisma.payrollRun.update({
          where: { id: run.id },
          data: { approvedByUserId: maker },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DRAFT' } }),
      ).rejects.toThrow();
      await expect(
        prisma.payrollLine.updateMany({ where: { runId: run.id }, data: { netPayPesewas: 1 } }),
      ).rejects.toThrow();

      // Only the record of payment may still be added.
      const paid = await prisma.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'PAID',
          paidByUserId: checker,
          paidAt: new Date(),
          paidOn: new Date('2026-09-28T00:00:00Z'),
          paymentReference: 'GCB-TRF-2026-09-0042',
        },
      });
      expect(paid.status).toBe('PAID');
    });

    it('allows only one approved run a month', async () => {
      // The period already carries the locked run from the test above.
      const second = await draftRun();
      await prisma.payrollRun.update({
        where: { id: second.id },
        data: { status: 'PENDING_APPROVAL', submittedByUserId: maker, submittedAt: new Date() },
      });
      await expect(
        prisma.payrollRun.update({
          where: { id: second.id },
          data: { status: 'LOCKED', approvedByUserId: checker, approvedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('never lets a run be deleted', async () => {
      const run = await draftRun();
      await expect(prisma.payrollRun.delete({ where: { id: run.id } })).rejects.toThrow();
    });
  });
});
