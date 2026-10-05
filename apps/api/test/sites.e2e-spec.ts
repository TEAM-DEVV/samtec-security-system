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
 * Adding and changing client sites (`POST /sites`, `PATCH /sites/{id}`),
 * against a real database: the code is unique in the company and can never
 * be changed, and a site cannot be switched to INACTIVE while anybody is
 * still posted there or one of its devices is switched on.
 *
 * A company of its own, so nothing here touches the shared fixture company.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const DASHBOARD_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'a password only these tests know';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe.skipIf(!databaseUrl)('adding and changing sites (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let companyId = '';
  let admin = '';

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    const company = await prisma.company.create({ data: { name: `Sites ${randomUUID()}` } });
    companyId = company.id;
    const email = `admin-${randomUUID()}@sites.example`;
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
    admin = verified.body.accessToken;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  function createSite(body: Record<string, unknown>, token = admin) {
    return request(app.getHttpServer())
      .post('/api/v1/sites')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function updateSite(siteId: string, body: Record<string, unknown>, token = admin) {
    return request(app.getHttpServer())
      .patch(`/api/v1/sites/${siteId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  /** A fresh, randomised site code shaped like the contract wants: ABC-12. */
  function freshCode(): string {
    const letters = Array.from({ length: 2 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
    const digits = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    return `S${letters}-${digits}`;
  }

  it('adds a site, starting ACTIVE with no guards yet', async () => {
    const code = freshCode();
    const created = await createSite({
      code,
      name: 'Airport City Office Park',
      clientName: 'Airport City Properties Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);

    expect(created.headers.location).toBe(`/api/v1/sites/${created.body.id}`);
    expect(created.body).toMatchObject({
      code,
      name: 'Airport City Office Park',
      clientName: 'Airport City Properties Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
      status: 'ACTIVE',
      activeGuardCount: 0,
    });

    const audit = await prisma.auditLog.findFirst({
      where: { companyId, entityId: created.body.id, action: 'site.created' },
    });
    expect(audit).not.toBeNull();
  });

  it('can be created INACTIVE straight away', async () => {
    const created = await createSite({
      code: freshCode(),
      name: 'Pedu Junction Bank Branch',
      clientName: 'Fanti Coast Savings Ltd',
      region: 'CENTRAL',
      city: 'Cape Coast',
      status: 'INACTIVE',
    }).expect(201);

    expect(created.body.status).toBe('INACTIVE');
  });

  it('refuses a badly shaped code', async () => {
    const refused = await createSite({
      code: 'accra-1',
      name: 'Somewhere',
      clientName: 'Somebody Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(400);

    expect(JSON.stringify(refused.body)).toContain('code');
  });

  it('refuses a second site with the same code in the company', async () => {
    const code = freshCode();
    await createSite({
      code,
      name: 'First Site',
      clientName: 'First Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);

    const refused = await createSite({
      code,
      name: 'Second Site',
      clientName: 'Second Client Ltd',
      region: 'ASHANTI',
      city: 'Kumasi',
    }).expect(409);

    expect(JSON.stringify(refused.body)).toContain('already exists');
  });

  it('refuses a supervisor', async () => {
    // A SUPERVISOR account must belong to an employee (a database CHECK).
    // The staff number stays in the API's own SMT-NNNNN numeric shape (a
    // non-numeric one would break `nextStaffNumber`'s highest-so-far lookup
    // for every employee the rest of this file creates through the API).
    const supervisorEmployee = await prisma.employee.create({
      data: {
        companyId,
        staffNumber: 'SMT-90001',
        firstName: 'Yaw',
        lastName: 'Owusu',
        phone: `+23320${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}-6`,
        position: 'Site Supervisor',
        hireDate: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const supervisorEmail = `supervisor-${randomUUID()}@sites.example`;
    await prisma.user.create({
      data: {
        companyId,
        email: supervisorEmail,
        passwordHash: await hashPassword(PASSWORD, TEST_ONLY_SCRYPT_PARAMS),
        fullName: 'Yaw Supervisor',
        role: 'SUPERVISOR',
        employeeId: supervisorEmployee.id,
      },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email: supervisorEmail, password: PASSWORD })
      .expect(200);

    await createSite(
      {
        code: freshCode(),
        name: 'Somewhere',
        clientName: 'Somebody Ltd',
        region: 'GREATER_ACCRA',
        city: 'Accra',
      },
      login.body.accessToken,
    ).expect(403);
  });

  it('changes a site’s details, but never its code', async () => {
    const created = await createSite({
      code: freshCode(),
      name: 'Old Name',
      clientName: 'Old Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);

    const updated = await updateSite(created.body.id, {
      name: 'New Name',
      clientName: 'New Client Ltd',
      region: 'ASHANTI',
      city: 'Kumasi',
    }).expect(200);

    expect(updated.body).toMatchObject({
      code: created.body.code,
      name: 'New Name',
      clientName: 'New Client Ltd',
      region: 'ASHANTI',
      city: 'Kumasi',
    });

    const audit = await prisma.auditLog.findFirst({
      where: { companyId, entityId: created.body.id, action: 'site.updated' },
    });
    expect(audit?.detail).toEqual({ changedFields: 'name,clientName,region,city' });

    const refused = await updateSite(created.body.id, { code: 'ZZZ-99' }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('code');
  });

  it('answers 404 for a site that does not exist', async () => {
    await updateSite(randomUUID(), { name: 'Anything' }).expect(404);
  });

  it('refuses to go INACTIVE while a worker is posted there', async () => {
    const site = await createSite({
      code: freshCode(),
      name: 'Staffed Site',
      clientName: 'Staffed Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        firstName: 'Nana',
        lastName: 'Perkins',
        phone: `+23320${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}-4`,
        position: 'Security Guard',
        hireDate: '2026-01-05',
        siteId: site.body.id,
      })
      .expect(201);

    const refused = await updateSite(site.body.id, { status: 'INACTIVE' }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Move every worker off this site');

    const stillActive = await request(app.getHttpServer())
      .get(`/api/v1/sites/${site.body.id}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(stillActive.body.status).toBe('ACTIVE');
  });

  it('refuses to go INACTIVE while one of its devices is switched on', async () => {
    const site = await createSite({
      code: freshCode(),
      name: 'Device Site',
      clientName: 'Device Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);
    await prisma.device.create({
      data: {
        companyId,
        siteId: site.body.id,
        name: `Terminal ${randomUUID()}`,
        kind: 'ZKTECO',
        status: 'ACTIVE',
        secretEncrypted: 'not-a-real-secret',
      },
    });

    const refused = await updateSite(site.body.id, { status: 'INACTIVE' }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Switch off every device');
  });

  it('refuses to go INACTIVE when both a worker and a device are still there', async () => {
    const site = await createSite({
      code: freshCode(),
      name: 'Busy Site',
      clientName: 'Busy Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        firstName: 'Kojo',
        lastName: 'Appiah',
        phone: `+23320${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}-5`,
        position: 'Security Guard',
        hireDate: '2026-01-05',
        siteId: site.body.id,
      })
      .expect(201);
    await prisma.device.create({
      data: {
        companyId,
        siteId: site.body.id,
        name: `Terminal ${randomUUID()}`,
        kind: 'ZKTECO',
        status: 'ACTIVE',
        secretEncrypted: 'not-a-real-secret',
      },
    });

    const refused = await updateSite(site.body.id, { status: 'INACTIVE' }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('Move every worker off this site and switch off');
  });

  it('goes INACTIVE once nobody is posted there and no device is switched on', async () => {
    const site = await createSite({
      code: freshCode(),
      name: 'Empty Site',
      clientName: 'Empty Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);

    const updated = await updateSite(site.body.id, { status: 'INACTIVE' }).expect(200);

    expect(updated.body.status).toBe('INACTIVE');
  });

  it('allows an inactive device at the site: only a switched-on one blocks it', async () => {
    const site = await createSite({
      code: freshCode(),
      name: 'Quiet Device Site',
      clientName: 'Quiet Client Ltd',
      region: 'GREATER_ACCRA',
      city: 'Accra',
    }).expect(201);
    await prisma.device.create({
      data: {
        companyId,
        siteId: site.body.id,
        name: `Spare terminal ${randomUUID()}`,
        kind: 'ZKTECO',
        status: 'INACTIVE',
        secretEncrypted: 'not-a-real-secret',
      },
    });

    const updated = await updateSite(site.body.id, { status: 'INACTIVE' }).expect(200);

    expect(updated.body.status).toBe('INACTIVE');
  });
});
