import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import { type AttendanceCompany, createAttendanceCompany, tokensFor } from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The company's own bank account (`GET`/`PUT /company/bank-account`), against
 * a real database.
 *
 * The one fact every test here protects is that a full account number never
 * leaves this endpoint: a `GET`, and the response to a `PUT`, both carry only
 * `accountNumberMasked`, never the number itself — and neither does the audit
 * log.
 *
 * Makes its own company, the same reason every other e2e test touching
 * payroll-adjacent tables does: nothing here should depend on, or disturb,
 * the shared fixture company.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('the company bank account (e2e)', () => {
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const ACCOUNT = {
    bankName: 'Akwaaba Bank',
    branch: 'Ridge',
    accountName: 'Test Attendance Company',
    accountNumber: '9876500011222',
  };

  it('starts with nothing on file: every field null, masked or not', async () => {
    const read = await api()
      .get('/api/v1/company/bank-account')
      .set(...bearer(token.hr))
      .expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    // Set by `createAttendanceCompany`; confirms the name is the company's own.
    expect(read.body.companyName).toMatch(/^Attendance Test /);
    expect(read.body).toMatchObject({
      bankName: null,
      branch: null,
      accountName: null,
      accountNumberMasked: null,
    });
  });

  it('refuses a supervisor and a guard, who have no business with payroll at all', async () => {
    for (const forbidden of [token.supervisor, token.guard]) {
      await api()
        .get('/api/v1/company/bank-account')
        .set(...bearer(forbidden))
        .expect(403);
    }
  });

  it('refuses to change it without a fresh password confirmation, even for an ADMIN', async () => {
    // `tokensFor` signs every token already confirmed, so an unconfirmed
    // ADMIN token is signed directly here, the way
    // `password-confirmation.e2e-spec.ts` does.
    const unconfirmedAdmin = await app.get(TokensService).signAccessToken({
      userId: company.adminUserId,
      companyId: company.companyId,
      role: 'ADMIN',
      employeeId: null,
      onKiosk: false,
      passwordConfirmedAt: null,
    });
    const refused = await api()
      .put('/api/v1/company/bank-account')
      .set(...bearer(unconfirmedAdmin))
      .send(ACCOUNT)
      .expect(403);
    expect(refused.body.code).toBe('PASSWORD_CONFIRMATION_REQUIRED');
  });

  it('refuses HR_PAYROLL, a supervisor and a guard: only ADMIN may set it', async () => {
    for (const forbidden of [token.hr, token.supervisor, token.guard]) {
      await api()
        .put('/api/v1/company/bank-account')
        .set(...bearer(forbidden))
        .send(ACCOUNT)
        .expect(403);
    }
  });

  it('sets the account, masks the number to its last four digits, and audits only which fields moved', async () => {
    const saved = await api()
      .put('/api/v1/company/bank-account')
      .set(...bearer(token.admin))
      .send(ACCOUNT)
      .expect(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.body).toMatchObject({
      bankName: 'Akwaaba Bank',
      branch: 'Ridge',
      accountName: 'Test Attendance Company',
      accountNumberMasked: '**** 1222',
    });
    // The real number is nowhere in the response.
    expect(JSON.stringify(saved.body)).not.toContain(ACCOUNT.accountNumber);

    const read = await api()
      .get('/api/v1/company/bank-account')
      .set(...bearer(token.hr))
      .expect(200);
    expect(read.body.accountNumberMasked).toBe('**** 1222');

    const audited = await prisma.auditLog.findFirst({
      where: { companyId: company.companyId, action: 'company.bank_account_changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited).not.toBeNull();
    expect(audited?.actorUserId).toBe(company.adminUserId);
    // Which fields moved, never a value — and never the account number.
    const detail = JSON.stringify(audited?.detail);
    expect(detail).toContain('bankName');
    expect(detail).toContain('accountNumber');
    expect(detail).not.toContain(ACCOUNT.accountNumber);
  });

  it('replaces the whole account: sending null again clears every field', async () => {
    const cleared = await api()
      .put('/api/v1/company/bank-account')
      .set(...bearer(token.admin))
      .send({ bankName: null, branch: null, accountName: null, accountNumber: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      bankName: null,
      branch: null,
      accountName: null,
      accountNumberMasked: null,
    });
  });

  it('refuses a field the contract does not recognise, and an account number in the wrong shape', async () => {
    await api()
      .put('/api/v1/company/bank-account')
      .set(...bearer(token.admin))
      .send({ ...ACCOUNT, extra: 'not allowed' })
      .expect(400);
    const badNumber = await api()
      .put('/api/v1/company/bank-account')
      .set(...bearer(token.admin))
      .send({ ...ACCOUNT, accountNumber: 'not-digits' })
      .expect(400);
    expect(badNumber.body.errors).toEqual([
      expect.objectContaining({ path: 'accountNumber' }),
    ]);
  });
});
