import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { signRequest } from '../src/modules/attendance/device-signature.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import { totpCode, totpStep } from '../src/modules/identity/totp.js';
import { type AttendanceCompany, createAttendanceCompany } from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The kiosk door, on a real database (docs/plan/13 section 2): where a
 * sign-in may come from, what a kiosk session may do, and the first thing
 * that happens at a kiosk — the worker's consent.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const DASHBOARD = 'http://localhost:5173';
const KIOSK = 'http://localhost:5174';

describe.skipIf(!databaseUrl)('The kiosk door (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let kiosk: { id: string; secret: string };
  let terminal: { id: string; secret: string };
  let kioskAdmin = '';
  let dashboardAdmin = '';
  let supervisorEmail = '';
  let plainAdminEmail = '';
  /** An ADMIN whose authenticator secret the test knows, so it can sign in for real. */
  let realAdminEmail = '';
  const REAL_ADMIN_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

  /** A kiosk ADMIN request: the ADMIN's token and the kiosk's signature together. */
  const kioskPost = (
    route: 'kiosk/consents',
    body: unknown,
    options: { token?: string; device?: { id: string; secret: string } } = {},
  ) => {
    const device = options.device ?? kiosk;
    const token = options.token ?? kioskAdmin;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = JSON.stringify(body);
    return request(app.getHttpServer())
      .post(`/api/v1/${route}`)
      .set('Content-Type', 'application/json')
      .set(...bearer(token))
      .set('X-Samtec-Device', device.id)
      .set('X-Samtec-Timestamp', timestamp)
      .set('X-Samtec-Signature', signRequest(device.secret, timestamp, route, text))
      .send(text);
  };

  const registerDevice = async (name: string, kind: 'FACE_KIOSK' | 'ZKTECO') => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set(...bearer(dashboardAdmin))
      .send({ name, siteId: company.siteA, kind })
      .expect(201);
    return { id: response.body.device.id, secret: response.body.secret };
  };

  /** A fresh worker with no consent and no face yet. */
  let starters = 0;
  const newStarter = async () => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    return prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-72${n.slice(1)}`,
        firstName: 'Kiosk',
        lastName: `Starter ${starters}`,
        phone: `+23320777${n}`,
        ghanaCardNumber: `GHA-7${n.padStart(8, '0')}-${starters % 10}`,
        position: 'Security Guard',
        status: 'PENDING_ENROLLMENT',
        hireDate: new Date('2026-01-05T00:00:00Z'),
      },
    });
  };

  /** The last 4 digits of a worker's card, as the ADMIN reads them off it. */
  const cardLast4 = async (employeeId: string) => {
    const row = await prisma.employee.findFirstOrThrow({ where: { id: employeeId } });
    return row.ghanaCardNumber.replace(/\D/g, '').slice(-4);
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);

    const tokens = app.get(TokensService);
    const signIn = (onKiosk: boolean) =>
      tokens.signAccessToken({
        userId: company.adminUserId,
        companyId: company.companyId,
        role: 'ADMIN',
        employeeId: null,
        onKiosk,
      });
    kioskAdmin = await signIn(true);
    dashboardAdmin = await signIn(false);

    kiosk = await registerDevice('Kiosk door test kiosk', 'FACE_KIOSK');
    terminal = await registerDevice('Kiosk door test terminal', 'ZKTECO');

    const supervisor = await prisma.user.findFirstOrThrow({
      where: { id: company.supervisorUserId },
    });
    supervisorEmail = supervisor.email;
    // An ADMIN who has not set up two-factor yet, to prove a kiosk never does it.
    const admin = await prisma.user.findFirstOrThrow({ where: { id: company.adminUserId } });
    plainAdminEmail = `plain-${admin.email}`;
    await prisma.user.create({
      data: {
        companyId: company.companyId,
        email: plainAdminEmail,
        passwordHash: admin.passwordHash,
        fullName: 'Plain Admin',
        role: 'ADMIN',
      },
    });
    // An ADMIN with two-factor already set up, so a whole kiosk sign-in can be
    // done the way a real one is: password, then a code from the app.
    realAdminEmail = `real-${admin.email}`;
    await prisma.user.create({
      data: {
        companyId: company.companyId,
        email: realAdminEmail,
        passwordHash: admin.passwordHash,
        fullName: 'Real Admin',
        role: 'ADMIN',
        twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
        twoFactorSecretEncrypted: tokens.encryptSecret(REAL_ADMIN_SECRET),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('where a sign-in may come from', () => {
    const login = (origin: string | null, email: string) => {
      const call = request(app.getHttpServer()).post('/api/v1/auth/login');
      if (origin) {
        call.set('Origin', origin);
      }
      return call.send({ email, password: 'demo-password' });
    };

    it('refuses a sign-in from anywhere but the dashboard or a kiosk', async () => {
      for (const origin of ['https://not-ours.example', null]) {
        const response = await login(origin, supervisorEmail).expect(403);
        expect(response.body.detail).toMatch(/dashboard or a kiosk/);
      }
    });

    it('remembers a dashboard sign-in in a cookie, and a kiosk sign-in nowhere', async () => {
      const dashboard = await login(DASHBOARD, supervisorEmail).expect(200);
      expect(String(dashboard.headers['set-cookie'])).toContain('samtec_refresh=');

      // The whole kiosk sign-in, the way a real one goes: password, then a
      // code from the ADMIN's authenticator app.
      const started = await login(KIOSK, realAdminEmail).expect(200);
      expect(started.body.status).toBe('TWO_FACTOR_REQUIRED');
      const finished = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/verify')
        .set('Origin', KIOSK)
        .send({
          challengeToken: started.body.challengeToken,
          code: totpCode(REAL_ADMIN_SECRET, totpStep()),
        })
        .expect(200);

      // Nothing is remembered on a shared device...
      expect(finished.headers['set-cookie']).toBeUndefined();
      // ...and the token it hands out only opens the kiosk screens.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(finished.body.accessToken))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/attendance/exceptions')
        .set(...bearer(finished.body.accessToken))
        .expect(403);
    });

    it('lets only an administrator sign in at a kiosk', async () => {
      const response = await login(KIOSK, supervisorEmail).expect(403);
      expect(response.body.detail).toMatch(/Only an administrator/);

      // The same supervisor signs in on the dashboard as always.
      await login(DASHBOARD, supervisorEmail).expect(200);
    });

    it('lets the kiosk app call the API from its own address', async () => {
      // Without this, a real browser would refuse before any of the rules
      // above ever ran.
      const allowed = await request(app.getHttpServer())
        .options('/api/v1/auth/login')
        .set('Origin', KIOSK)
        .set('Access-Control-Request-Method', 'POST');
      expect(allowed.headers['access-control-allow-origin']).toBe(KIOSK);

      const dashboard = await request(app.getHttpServer())
        .options('/api/v1/auth/login')
        .set('Origin', DASHBOARD)
        .set('Access-Control-Request-Method', 'POST');
      expect(dashboard.headers['access-control-allow-origin']).toBe(DASHBOARD);

      const stranger = await request(app.getHttpServer())
        .options('/api/v1/auth/login')
        .set('Origin', 'https://not-ours.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('never sets up two-factor on a shared kiosk screen', async () => {
      const response = await login(KIOSK, plainAdminEmail).expect(403);
      expect(response.body.detail).toMatch(/dashboard/);

      // The same account may set it up from the dashboard.
      const fromDashboard = await login(DASHBOARD, plainAdminEmail).expect(200);
      expect(fromDashboard.body.status).toBe('TWO_FACTOR_SETUP_REQUIRED');
    });

    it('finishes a half-done sign-in only where it started', async () => {
      const started = await login(DASHBOARD, plainAdminEmail).expect(200);

      const moved = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/setup')
        .set('Origin', KIOSK)
        .send({ setupToken: started.body.setupToken })
        .expect(403);
      expect(moved.body.detail).toMatch(/where you started/);

      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/setup')
        .set('Origin', DASHBOARD)
        .send({ setupToken: started.body.setupToken })
        .expect(200);
    });
  });

  describe('what a kiosk session may do', () => {
    it('opens the kiosk screens', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(kioskAdmin))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/employees?limit=1')
        .set(...bearer(kioskAdmin))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/sites?limit=1')
        .set(...bearer(kioskAdmin))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/biometrics/consent-text')
        .set(...bearer(kioskAdmin))
        .expect(200);
    });

    it('and nothing else, even for an ADMIN', async () => {
      for (const path of [
        '/api/v1/attendance/segments?date=2026-09-21',
        '/api/v1/attendance/exceptions',
        `/api/v1/employees/${company.active.id}`,
        '/api/v1/users',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .set(...bearer(kioskAdmin))
          .expect(403);
        expect(response.body.detail).toBe('This kiosk session can only use the kiosk screens.');
      }
      // The very same account may do all of it from the dashboard.
      await request(app.getHttpServer())
        .get(`/api/v1/employees/${company.active.id}`)
        .set(...bearer(dashboardAdmin))
        .expect(200);
    });

    it('sets up a kiosk, but never a terminal or a simulator', async () => {
      for (const kind of ['ZKTECO', 'MOCK']) {
        const response = await request(app.getHttpServer())
          .post('/api/v1/devices')
          .set(...bearer(kioskAdmin))
          .send({ name: `Kiosk tried a ${kind}`, siteId: company.siteA, kind })
          .expect(403);
        expect(response.body.detail).toMatch(/only set up a face kiosk/);
      }
      const made = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(kioskAdmin))
        .send({ name: 'Kiosk set itself up', siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      // It waits, switched off, until an ADMIN switches it on from the
      // dashboard: a kiosk session alone can never make a working key.
      expect(made.body.device.status).toBe('INACTIVE');
      const waiting = { id: made.body.device.id, secret: made.body.secret };
      const worker = await newStarter();
      const consent = {
        employeeId: worker.id,
        ghanaCardLast4: await cardLast4(worker.id),
        textVersion: 'bio-v1',
      };
      await kioskPost('kiosk/consents', consent, { device: waiting }).expect(401);

      await request(app.getHttpServer())
        .patch(`/api/v1/devices/${waiting.id}`)
        .set(...bearer(dashboardAdmin))
        .send({ status: 'ACTIVE' })
        .expect(200);
      await kioskPost('kiosk/consents', consent, { device: waiting }).expect(201);

      // It may rotate its own secret, never a terminal's.
      await request(app.getHttpServer())
        .post(`/api/v1/devices/${made.body.device.id}/rotate-secret`)
        .set(...bearer(kioskAdmin))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/devices/${terminal.id}/rotate-secret`)
        .set(...bearer(kioskAdmin))
        .expect(403);
    });
  });

  describe('recording consent', () => {
    it('needs the kiosk and the ADMIN together', async () => {
      const worker = await newStarter();
      const body = {
        employeeId: worker.id,
        ghanaCardLast4: await cardLast4(worker.id),
        textVersion: 'bio-v1',
      };

      // A dashboard token, even with the kiosk's signature.
      await kioskPost('kiosk/consents', body, { token: dashboardAdmin }).expect(401);
      // The kiosk's ADMIN, but signed by a terminal.
      await kioskPost('kiosk/consents', body, { device: terminal }).expect(401);
      // No signature at all.
      await request(app.getHttpServer())
        .post('/api/v1/kiosk/consents')
        .set(...bearer(kioskAdmin))
        .send(body)
        .expect(401);

      await kioskPost('kiosk/consents', body).expect(201);
    });

    it('refuses a kiosk that belongs to another company', async () => {
      const elsewhere = await createAttendanceCompany(prisma);
      const theirAdmin = await app.get(TokensService).signAccessToken({
        userId: elsewhere.adminUserId,
        companyId: elsewhere.companyId,
        role: 'ADMIN',
        employeeId: null,
        onKiosk: true,
      });
      const worker = await newStarter();

      // Their ADMIN, correctly signed in on a kiosk, but our kiosk.
      await kioskPost(
        'kiosk/consents',
        {
          employeeId: worker.id,
          ghanaCardLast4: await cardLast4(worker.id),
          textVersion: 'bio-v1',
        },
        { token: theirAdmin },
      ).expect(401);
    });

    it('records the exact words the worker agreed to, once', async () => {
      const worker = await newStarter();
      const text = await request(app.getHttpServer())
        .get('/api/v1/biometrics/consent-text')
        .set(...bearer(kioskAdmin))
        .expect(200);
      const body = {
        employeeId: worker.id,
        ghanaCardLast4: await cardLast4(worker.id),
        textVersion: text.body.version,
      };

      const first = await kioskPost('kiosk/consents', body).expect(201);
      expect(first.body.status).toBe('GIVEN');
      expect(first.body.textSha256).toBe(text.body.sha256);
      expect(first.body.deviceId).toBe(kiosk.id);

      // Enrolling again: the card is checked again, and the same consent comes back.
      const again = await kioskPost('kiosk/consents', body).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(await prisma.biometricConsent.count({ where: { employeeId: worker.id } })).toBe(1);
    });

    it('refuses old wording', async () => {
      const worker = await newStarter();
      const response = await kioskPost('kiosk/consents', {
        employeeId: worker.id,
        ghanaCardLast4: await cardLast4(worker.id),
        textVersion: 'bio-v0',
      }).expect(400);
      expect(JSON.stringify(response.body)).toMatch(/textVersion/);
    });

    it('checks the card the worker is holding, and makes them wait after five wrong answers', async () => {
      const worker = await newStarter();
      const right = await cardLast4(worker.id);
      const wrong = right === '0000' ? '1111' : '0000';
      const answer = (ghanaCardLast4: string) =>
        kioskPost('kiosk/consents', {
          employeeId: worker.id,
          ghanaCardLast4,
          textVersion: 'bio-v1',
        });

      const refused = await answer(wrong).expect(400);
      expect(JSON.stringify(refused.body)).toMatch(/ghanaCardLast4/);
      expect(
        await prisma.auditLog.count({
          where: { entityId: worker.id, action: 'biometric.card_check_failed' },
        }),
      ).toBe(1);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await answer(wrong).expect(400);
      }
      // Five wrong answers: this worker waits, even for the right digits.
      await answer(wrong).expect(429);
      await answer(right).expect(429);
      expect(await prisma.biometricConsent.count({ where: { employeeId: worker.id } })).toBe(0);
    });

    it('records nothing for a worker who has left', async () => {
      const response = await kioskPost('kiosk/consents', {
        employeeId: company.leaver.id,
        ghanaCardLast4: await cardLast4(company.leaver.id),
        textVersion: 'bio-v1',
      }).expect(409);
      expect(response.body.detail).toMatch(/has left/);
    });

    it('answers 404 for someone who is not in this company', async () => {
      const elsewhere = await createAttendanceCompany(prisma);
      await kioskPost('kiosk/consents', {
        employeeId: elsewhere.active.id,
        ghanaCardLast4: '0000',
        textVersion: 'bio-v1',
      }).expect(404);
    });
  });
});
