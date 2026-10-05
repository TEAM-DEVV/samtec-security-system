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
 * The client invoice, against a real database.
 *
 * Only `CONFIRMED` shifts, only the billed site, and only the billed month
 * are the three ways this could silently over- or under-bill a client, so
 * each has its own test here rather than being left to the unit test's
 * fixture data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Client invoice (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let other: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  /**
   * A shift on one date, at one site, for one employee. `MANUAL` saves
   * inventing punch rows. A `VOIDED` one carries `voidedAt`, which the
   * database's own `work_segments_void_matches_status` check demands goes
   * with that status and no other (see the phase 2 migration).
   */
  const shift = (
    employeeId: string,
    siteId: string,
    workDate: string,
    workedMinutes: number,
    status: 'CONFIRMED' | 'DISPUTED' | 'VOIDED' = 'CONFIRMED',
  ) => {
    const startedAt = new Date(`${workDate}T06:00:00Z`);
    return prisma.workSegment.create({
      data: {
        companyId: company.companyId,
        employeeId,
        siteId,
        workDate: new Date(`${workDate}T00:00:00Z`),
        startedAt,
        endedAt: new Date(startedAt.getTime() + workedMinutes * 60_000),
        workedMinutes,
        basis: 'MANUAL',
        status,
        voidedAt: status === 'VOIDED' ? new Date() : null,
        voidedByUserId: status === 'VOIDED' ? company.adminUserId : null,
      },
    });
  };

  const invoiceUrl = (siteId: string, month: string, hourlyRatePesewas: number | string = 1_000) =>
    `/api/v1/sites/${siteId}/invoices/${month}.pdf?hourlyRatePesewas=${hourlyRatePesewas}`;

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    other = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    token = await tokensFor(app, company);

    // Billed: two confirmed shifts for the active guard, in September 2026.
    await shift(company.active.id, company.siteA, '2026-09-05', 480);
    await shift(company.active.id, company.siteA, '2026-09-06', 480);
    // Billed too: the supervisor (also an employee) worked a shift there.
    await shift(company.supervisorEmployeeId, company.siteA, '2026-09-10', 600);

    // None of these should ever appear on the September invoice for site A.
    // Each is its own date: a CONFIRMED shift may not overlap another of the
    // same worker's (the database's own exclusion constraint), so reusing a
    // date already billed above would fail here, not prove anything about
    // the invoice.
    await shift(company.active.id, company.siteA, '2026-09-07', 480, 'DISPUTED');
    await shift(company.active.id, company.siteA, '2026-09-08', 480, 'VOIDED');
    await shift(company.active.id, company.siteA, '2026-08-31', 480); // the month before
    await shift(company.active.id, company.siteB, '2026-09-09', 480); // a different site
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('bills only the counted hours: confirmed, at this site, in this month', async () => {
    const file = await api()
      .get(invoiceUrl(company.siteA, '2026-09'))
      .set(...bearer(token.admin))
      .expect(200);

    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="invoice-ATA-01-2026-09.pdf"',
    );
    expect(file.headers['cache-control']).toBe('no-store');

    const text = Buffer.from(file.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('INV-ATA-01-202609');
    expect(text).toContain('Test Client Ltd');
    expect(text).toContain('ATA-01');
    expect(text).toContain('Test site ATA-01');
    expect(text).toContain('For September 2026');

    // Both billed workers, with their staff numbers and hours.
    expect(text).toContain(company.active.staffNumber);
    expect(text).toContain('16.00h'); // 480 + 480 confirmed minutes at site A
    const supervisorRef = await prisma.employee.findUniqueOrThrow({
      where: { id: company.supervisorEmployeeId },
      select: { staffNumber: true },
    });
    expect(text).toContain(supervisorRef.staffNumber);
    expect(text).toContain('10.00h');

    // 960 + 600 confirmed minutes at site A only: the disputed, voided, other
    // month and other site shifts are all left out.
    expect(text).toContain('26.00h');
    // At GHS 10.00 an hour: GHS 160.00 + GHS 100.00 = GHS 260.00.
    expect(text).toContain('160.00');
    expect(text).toContain('100.00');
    expect(text).toContain('GHS 260.00');
    expect(text).toContain('Taxes are not included.');
  });

  it('says so, rather than an empty table, for a month nothing was worked', async () => {
    const file = await api()
      .get(invoiceUrl(company.siteA, '2026-01'))
      .set(...bearer(token.hr))
      .expect(200);
    const text = Buffer.from(file.body as Buffer).toString('latin1');
    expect(text).toContain('No counted shifts were recorded at this site in this month.');
    expect(text).toContain('GHS 0.00');
  });

  it('is ADMIN and HR_PAYROLL work; a supervisor and a guard are refused', async () => {
    await api()
      .get(invoiceUrl(company.siteA, '2026-09'))
      .set(...bearer(token.supervisor))
      .expect(403);
    await api()
      .get(invoiceUrl(company.siteA, '2026-09'))
      .set(...bearer(token.guard))
      .expect(403);
  });

  it('answers 404 for a site outside the caller’s own company', async () => {
    await api()
      .get(invoiceUrl(other.siteA, '2026-09'))
      .set(...bearer(token.admin))
      .expect(404);
    await api()
      .get(invoiceUrl('01927c3e-0000-7000-8000-000000000000', '2026-09'))
      .set(...bearer(token.admin))
      .expect(404);
  });

  it('refuses a month that is not YYYY-MM', async () => {
    for (const month of ['2026-13', '2026-00', '2026-9', 'september', '2026/09']) {
      await api()
        .get(invoiceUrl(company.siteA, month))
        .set(...bearer(token.admin))
        .expect(400);
    }
  });

  it('refuses a rate that is missing, zero or not a whole number', async () => {
    await api()
      .get(`/api/v1/sites/${company.siteA}/invoices/2026-09.pdf`)
      .set(...bearer(token.admin))
      .expect(400);
    await api()
      .get(invoiceUrl(company.siteA, '2026-09', 0))
      .set(...bearer(token.admin))
      .expect(400);
    await api()
      .get(invoiceUrl(company.siteA, '2026-09', -5))
      .set(...bearer(token.admin))
      .expect(400);
    await api()
      .get(invoiceUrl(company.siteA, '2026-09', '12.5'))
      .set(...bearer(token.admin))
      .expect(400);
  });

  it('audits the download with the site, the month, and nothing from the invoice itself', async () => {
    await api()
      .get(invoiceUrl(company.siteA, '2026-09', 2_500))
      .set(...bearer(token.admin))
      .expect(200);

    const entries = await prisma.auditLog.findMany({
      where: { companyId: company.companyId, action: 'site.invoice_downloaded' },
    });
    expect(entries.length).toBeGreaterThan(0);
    const last = entries.at(-1);
    expect(last?.entityId).toBe(company.siteA);
    const written = JSON.stringify(entries);
    expect(written).toMatch(/2026-09/);
    // Never the rate, and never a worker's staff number.
    expect(written).not.toContain('2500');
    expect(written).not.toContain(company.active.staffNumber);
  });
});
