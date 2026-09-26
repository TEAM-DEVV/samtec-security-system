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
 * Reports (Phase 6) against a real database.
 *
 * The figures are counted from the same tables the screens read, so these tests
 * are mostly about who may see what, and about the two answers that are easy to
 * get wrong: a company with nothing scheduled, and a range somebody asks too
 * much of.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Reports (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let token: Awaited<ReturnType<typeof tokensFor>>;

  const api = () => request(app.getHttpServer());
  const bearer = (value: string): [string, string] => ['Authorization', `Bearer ${value}`];

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    token = await tokensFor(app, company);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('counts who is at work, and against how many active workers', async () => {
    const answer = await api()
      .get('/api/v1/reports/overview')
      .set(...bearer(token.admin))
      .expect(200);

    expect(answer.body.present.onShift).toBeGreaterThanOrEqual(0);
    expect(answer.body.present.activeEmployees).toBeGreaterThan(0);
    expect(answer.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says "nothing to compare" rather than "no absence" when nothing is scheduled', async () => {
    // The fixture posts nobody to a shift pattern, so there is no expectation.
    const answer = await api()
      .get('/api/v1/reports/overview')
      .set(...bearer(token.admin))
      .expect(200);

    expect(answer.body.absence.scheduledMinutes).toBe(0);
    // A zero rate would read as "nobody was ever absent", which is a different
    // claim entirely.
    expect(answer.body.absence.basisPoints).toBeNull();
  });

  it('has no payroll cost until a run has been approved', async () => {
    const answer = await api()
      .get('/api/v1/reports/overview')
      .set(...bearer(token.admin))
      .expect(200);
    expect(answer.body.payrollCost).toEqual([]);
  });

  it('lets a supervisor read the attendance figures but never the payroll cost', async () => {
    await api()
      .get('/api/v1/reports/overview')
      .set(...bearer(token.supervisor))
      .expect(200);
    await api()
      .get('/api/v1/reports/attendance.csv?from=2026-09-01&to=2026-09-30')
      .set(...bearer(token.supervisor))
      .expect(200);
    // Payroll cost is payroll, and a supervisor sees no payroll anywhere.
    await api()
      .get('/api/v1/reports/payroll-cost.csv')
      .set(...bearer(token.supervisor))
      .expect(403);
  });

  it('refuses a guard every company figure', async () => {
    for (const path of [
      '/api/v1/reports/overview',
      '/api/v1/reports/attendance.csv?from=2026-09-01&to=2026-09-30',
      '/api/v1/reports/payroll-cost.csv',
    ]) {
      await api()
        .get(path)
        .set(...bearer(token.guard))
        .expect(403);
    }
  });

  it('answers the attendance report as a quoted CSV download', async () => {
    const file = await api()
      .get('/api/v1/reports/attendance.csv?from=2026-09-01&to=2026-09-30')
      .set(...bearer(token.hr))
      .expect(200);

    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="attendance-2026-09-01-to-2026-09-30.csv"',
    );
    expect(file.headers['cache-control']).toBe('no-store');
    const csv = file.text ?? file.body.toString();
    // The file opens with the marker that tells Excel it is UTF-8, so an
    // accented Ghanaian name is not mangled by the reader's own codepage. The
    // bank file deliberately carries none — see `bank-export.ts`.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\n')[0]).toBe(
      '"work_date","staff_number","full_name","site","worked_minutes","worked_hours","clocked_in_by"',
    );
  });

  it('refuses a range longer than 92 days, and one that runs backwards', async () => {
    await api()
      .get('/api/v1/reports/attendance.csv?from=2026-01-01&to=2026-12-31')
      .set(...bearer(token.hr))
      .expect(400);
    await api()
      .get('/api/v1/reports/attendance.csv?from=2026-09-30&to=2026-09-01')
      .set(...bearer(token.hr))
      .expect(400);
  });

  it('refuses a date that is not a date, and a filter nobody asked for', async () => {
    await api()
      .get('/api/v1/reports/attendance.csv?from=last-tuesday&to=2026-09-30')
      .set(...bearer(token.hr))
      .expect(400);
    await api()
      .get('/api/v1/reports/attendance.csv?from=2026-09-01&to=2026-09-30&somethingElse=1')
      .set(...bearer(token.hr))
      .expect(400);
  });

  it('answers the payroll cost report as a CSV, with a header even when empty', async () => {
    const file = await api()
      .get('/api/v1/reports/payroll-cost.csv')
      .set(...bearer(token.hr))
      .expect(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="payroll-cost.csv"');
    const csv = file.text ?? file.body.toString();
    expect(csv.split('\n')[0]).toContain('"owed_to_the_state_pesewas"');
  });
});
