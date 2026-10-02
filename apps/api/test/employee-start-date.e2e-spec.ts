import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword, TEST_ONLY_SCRYPT_PARAMS } from '../src/modules/identity/password.js';
import { deriveKey, sealSecret } from '../src/modules/identity/secret-box.js';
import { totpCode, totpStep } from '../src/modules/identity/totp.js';
import { createDbTestApp, DB_TEST_AUTH_SECRET } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * Correcting an employee's start date (`PUT /employees/{id}/start-date`),
 * against a real database: it asks for the password, it carries the
 * employment period and the posting with it, and it refuses a later date
 * that would leave something recorded before the new start.
 *
 * A company of its own, so nothing here touches the shared fixture company.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const DASHBOARD_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'a password only these tests know';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe.skipIf(!databaseUrl)('correcting an employee start date (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let companyId = '';
  let siteId = '';
  /** Signed in, with a fresh password confirmation on the token. */
  let confirmed = '';
  /** Signed in, without one. */
  let bare = '';

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    const company = await prisma.company.create({ data: { name: `Start date ${randomUUID()}` } });
    companyId = company.id;
    const site = await prisma.site.create({
      data: {
        companyId,
        code: 'SDT-01',
        name: 'Start date test site',
        clientName: 'Test Client Ltd',
        region: 'GREATER_ACCRA',
        city: 'Accra',
      },
    });
    siteId = site.id;
    const email = `admin-${randomUUID()}@startdate.example`;
    await prisma.user.create({
      data: {
        companyId,
        email,
        passwordHash: await hashPassword(PASSWORD, TEST_ONLY_SCRYPT_PARAMS),
        fullName: 'Efua Admin',
        role: 'ADMIN',
        twoFactorSecretEncrypted: sealSecret(
          TOTP_SECRET,
          deriveKey(DB_TEST_AUTH_SECRET, 'secret-box'),
        ),
        twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    app = await createDbTestApp(databaseUrl as string);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email, password: PASSWORD })
      .expect(200);
    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/2fa/verify')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ challengeToken: login.body.challengeToken, code: totpCode(TOTP_SECRET, totpStep()) })
      .expect(200);
    bare = verified.body.accessToken;
    const step = await request(app.getHttpServer())
      .post('/api/v1/auth/confirm-password')
      .set('Authorization', `Bearer ${bare}`)
      .send({ password: PASSWORD })
      .expect(200);
    confirmed = step.body.accessToken;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  /** A newly hired worker on `hireDate`, posted to the test site from that day. */
  async function hire(hireDate: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${confirmed}`)
      .send({
        firstName: 'Nana',
        lastName: 'Perkins',
        phone: `+23320${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}-4`,
        position: 'Security Guard',
        hireDate,
        siteId,
      })
      .expect(201);
    return created.body.id as string;
  }

  function changeStartDate(employeeId: string, hireDate: string, token = confirmed) {
    return request(app.getHttpServer())
      .put(`/api/v1/employees/${employeeId}/start-date`)
      .set('Authorization', `Bearer ${token}`)
      .send({ hireDate });
  }

  it('asks for the password first', async () => {
    const id = await hire('2026-10-04');
    const refused = await changeStartDate(id, '2026-10-01', bare).expect(403);
    expect(refused.body.code).toBe('PASSWORD_CONFIRMATION_REQUIRED');
  });

  it('moves the start date earlier, with the employment period and the posting', async () => {
    const id = await hire('2026-10-04');

    const answer = await changeStartDate(id, '2026-09-25').expect(200);

    expect(answer.body.hireDate).toBe('2026-09-25');
    const period = await prisma.employmentPeriod.findFirstOrThrow({ where: { employeeId: id } });
    expect(period.startsOn.toISOString().slice(0, 10)).toBe('2026-09-25');
    const posting = await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: id } });
    expect(posting.startsOn.toISOString().slice(0, 10)).toBe('2026-09-25');
    const audit = await prisma.auditLog.findFirst({
      where: { companyId, entityId: id, action: 'employee.start_date_changed' },
    });
    expect(audit?.detail).toEqual({ from: '2026-10-04', to: '2026-09-25' });
  });

  it('moves it later too, and nothing stays posted before the new start', async () => {
    const id = await hire('2026-09-20');

    await changeStartDate(id, '2026-09-28').expect(200);

    const posting = await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: id } });
    expect(posting.startsOn.toISOString().slice(0, 10)).toBe('2026-09-28');
  });

  it('refuses a later date that would leave an ended posting before the new start', async () => {
    const id = await hire('2026-09-01');
    await prisma.siteAssignment.updateMany({
      where: { employeeId: id },
      data: { endsOn: new Date('2026-09-10T00:00:00Z') },
    });

    const refused = await changeStartDate(id, '2026-09-15').expect(409);

    expect(JSON.stringify(refused.body)).toContain('ended before that date');
  });

  it('refuses a leaver', async () => {
    const id = await hire('2026-09-01');
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${id}/terminate`)
      .set('Authorization', `Bearer ${confirmed}`)
      .send({ effectiveDate: '2026-09-30', reason: 'RESIGNED' })
      .expect(200);

    await changeStartDate(id, '2026-08-01').expect(409);
  });
});
