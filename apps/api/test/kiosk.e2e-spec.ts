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
    route: 'kiosk/consents' | 'kiosk/face-enrollments',
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

      // It may rotate a kiosk secret, never a terminal's...
      await request(app.getHttpServer())
        .post(`/api/v1/devices/${terminal.id}/rotate-secret`)
        .set(...bearer(kioskAdmin))
        .expect(403);
      // ...and the rotated kiosk waits to be switched on again, so a kiosk
      // session can never make a working key out of a kiosk already running.
      const running = await registerDevice('Kiosk already running', 'FACE_KIOSK');
      const rotated = await request(app.getHttpServer())
        .post(`/api/v1/devices/${running.id}/rotate-secret`)
        .set(...bearer(kioskAdmin))
        .expect(200);
      expect(rotated.body.device.status).toBe('INACTIVE');
      const newKey = { id: running.id, secret: rotated.body.secret };
      const someone = await newStarter();
      await kioskPost(
        'kiosk/consents',
        {
          employeeId: someone.id,
          ghanaCardLast4: await cardLast4(someone.id),
          textVersion: 'bio-v1',
        },
        { device: newKey },
      ).expect(401);
    });
  });

  describe('enrolling a face', () => {
    /**
     * This block does a lot of signed calls, so it uses a kiosk of its own:
     * the per-device limit of 60 a minute is then never in the way.
     */
    let enrolmentKiosk: { id: string; secret: string };

    beforeAll(async () => {
      enrolmentKiosk = await registerDevice('Enrolment kiosk', 'FACE_KIOSK');
      await request(app.getHttpServer())
        .patch(`/api/v1/devices/${enrolmentKiosk.id}`)
        .set(...bearer(dashboardAdmin))
        .send({ status: 'ACTIVE' })
        .expect(200);
    }, 60_000);

    /**
     * A face is 1,024 numbers. These are flat lists, where a step of 0.4
     * between two faces scores about 0.27 — far enough apart to be different
     * people, while the same level is the same face.
     */
    const faceAt = (level: number) => Array.from({ length: 1024 }, () => level);
    /** A face nobody else in this test file has. */
    let faces = 0;
    const anotherFace = () => {
      faces += 1;
      return faces * 0.4;
    };
    const sampleAt = (level: number, extra: Record<string, unknown> = {}) => ({
      model: 'human-faceres-1',
      embedding: faceAt(level),
      real: 0.9,
      live: 0.9,
      ...extra,
    });
    /** Three frames of one face, as the kiosk sends them. */
    const captureOf = (level: number) => [sampleAt(level), sampleAt(level + 0.01), sampleAt(level)];

    /**
     * Consent first, then the face: the whole enrollment as it really runs.
     * It hands back the finished answer, so each test checks the status itself.
     */
    const enroll = async (
      employeeId: string,
      level: number,
      options: { samples?: unknown[]; consentId?: string } = {},
    ) => {
      const consent = await kioskPost(
        'kiosk/consents',
        {
          employeeId,
          ghanaCardLast4: await cardLast4(employeeId),
          textVersion: 'bio-v1',
        },
        { device: enrolmentKiosk },
      );
      // Consent comes first, so its refusal is the answer.
      if (consent.status >= 400) {
        return consent;
      }
      return kioskPost(
        'kiosk/face-enrollments',
        {
          employeeId,
          consentId: options.consentId ?? consent.body.id,
          samples: options.samples ?? captureOf(level),
        },
        { device: enrolmentKiosk },
      );
    };

    it('stores the face, activates the worker and keeps no picture', async () => {
      const worker = await newStarter();

      const enrolled = await enroll(worker.id, anotherFace());

      expect(enrolled.status).toBe(201);
      expect(enrolled.body.dedupe).toBe('PASSED');
      expect(enrolled.body.employeeStatus).toBe('ACTIVE');
      const row = await prisma.biometricCredential.findUniqueOrThrow({
        where: { id: enrolled.body.credentialId },
      });
      expect(row.status).toBe('ACTIVE');
      expect(row.faceModel).toBe('human-faceres-1');
      expect(row.templateSealed).not.toBeNull();
      // Sealed numbers, never the numbers themselves and never a picture.
      expect(Buffer.from(row.templateSealed ?? []).includes(Buffer.from('0.4'))).toBe(false);
      const after = await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.biometricEnrolledAt).not.toBeNull();
    });

    it('refuses a capture that is not one real, live face', async () => {
      const worker = await newStarter();

      const mine = anotherFace();
      const notLive = await enroll(worker.id, mine, {
        samples: [sampleAt(mine), sampleAt(mine, { live: 0.1 }), sampleAt(mine)],
      });
      expect(notLive.status).toBe(400);
      expect(JSON.stringify(notLive.body)).toMatch(/samples\.1/);

      const twoPeople = await enroll(worker.id, mine, {
        samples: [sampleAt(mine), sampleAt(mine), sampleAt(mine + 1)],
      });
      expect(twoPeople.status).toBe(400);
      expect(JSON.stringify(twoPeople.body)).toMatch(/not the same face/);
    });

    it("needs this worker's own current consent", async () => {
      const worker = await newStarter();
      const other = await newStarter();
      const theirConsent = await kioskPost('kiosk/consents', {
        employeeId: other.id,
        ghanaCardLast4: await cardLast4(other.id),
        textVersion: 'bio-v1',
      });
      expect(theirConsent.status).toBe(201);

      // This worker has not agreed to anything yet.
      const noConsent = await kioskPost('kiosk/face-enrollments', {
        employeeId: worker.id,
        consentId: theirConsent.body.id,
        samples: captureOf(anotherFace()),
      });
      expect(noConsent.status).toBe(409);

      // Their own consent exists, but the kiosk named somebody else's.
      const wrongConsent = await enroll(worker.id, anotherFace(), {
        consentId: theirConsent.body.id,
      });
      expect(wrongConsent.status).toBe(400);
    });

    it('catches the same face enrolled under two names', async () => {
      const oneFace = anotherFace();
      const guard = await newStarter();
      expect((await enroll(guard.id, oneFace)).status).toBe(201);
      const ghost = await newStarter();

      // The ghost is enrolled with the guard's own face.
      const second = await enroll(ghost.id, oneFace);

      expect(second.status).toBe(201);
      expect(second.body.dedupe).toBe('COLLISION');
      expect(second.body.employeeStatus).toBe('PENDING_ENROLLMENT');
      const row = await prisma.biometricCredential.findUniqueOrThrow({
        where: { id: second.body.credentialId },
      });
      expect(row.status).toBe('PENDING');
      expect(row.collisionEmployeeId).toBe(guard.id);
      expect(Number(row.collisionSimilarity)).toBeGreaterThanOrEqual(0.5);
      // The kiosk is told nothing about who they looked like, or how closely.
      expect(JSON.stringify(second.body)).not.toContain(guard.id);
      expect(JSON.stringify(second.body)).not.toMatch(/similarity|score/i);
      const after = await prisma.employee.findUniqueOrThrow({ where: { id: ghost.id } });
      expect(after.status).toBe('PENDING_ENROLLMENT');
    });

    it('is refused while a second ADMIN owes an answer', async () => {
      const oneFace = anotherFace();
      const guard = await newStarter();
      expect((await enroll(guard.id, oneFace)).status).toBe(201);
      const ghost = await newStarter();
      expect((await enroll(ghost.id, oneFace)).status).toBe(201);

      // The ghost now has an open review: nothing more is recorded for them,
      // so nobody can capture again until a score slips under the threshold.
      expect((await enroll(ghost.id, anotherFace())).status).toBe(409);
    });

    it("replaces a worker's own face, wiping the old one", async () => {
      const worker = await newStarter();
      const first = await enroll(worker.id, anotherFace());
      expect(first.status).toBe(201);

      const second = await enroll(worker.id, anotherFace());

      expect(second.status).toBe(201);
      expect(second.body.dedupe).toBe('PASSED');
      const old = await prisma.biometricCredential.findUniqueOrThrow({
        where: { id: first.body.credentialId },
      });
      expect(old.status).toBe('REVOKED');
      expect(old.templateSealed).toBeNull();
      expect(
        await prisma.biometricCredential.count({
          where: { employeeId: worker.id, kind: 'FACE', wipedAt: null },
        }),
      ).toBe(1);
    });

    it('leaves a suspended worker suspended', async () => {
      const worker = await newStarter();
      await prisma.employee.update({ where: { id: worker.id }, data: { status: 'SUSPENDED' } });

      const enrolled = await enroll(worker.id, anotherFace());

      expect(enrolled.status).toBe(201);
      expect(enrolled.body.dedupe).toBe('PASSED');
      expect(enrolled.body.employeeStatus).toBe('SUSPENDED');
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

    it('counts wrong answers that all arrive at the same moment', async () => {
      const worker = await newStarter();
      const right = await cardLast4(worker.id);
      const wrong = right === '0000' ? '1111' : '0000';

      // Twenty at once: only the five the rule allows may reach the card.
      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          kioskPost('kiosk/consents', {
            employeeId: worker.id,
            ghanaCardLast4: wrong,
            textVersion: 'bio-v1',
          }),
        ),
      );
      const reachedTheCard = answers.filter((answer) => answer.status === 400).length;

      expect(reachedTheCard).toBe(5);
      expect(answers.filter((answer) => answer.status === 429)).toHaveLength(15);
    });

    it('records one consent when two kiosks ask at the same moment', async () => {
      const worker = await newStarter();
      const second = await registerDevice('Second kiosk at the site', 'FACE_KIOSK');
      await request(app.getHttpServer())
        .patch(`/api/v1/devices/${second.id}`)
        .set(...bearer(dashboardAdmin))
        .send({ status: 'ACTIVE' })
        .expect(200);
      const body = {
        employeeId: worker.id,
        ghanaCardLast4: await cardLast4(worker.id),
        textVersion: 'bio-v1',
      };

      const [first, other] = await Promise.all([
        kioskPost('kiosk/consents', body),
        kioskPost('kiosk/consents', body, { device: second }),
      ]);

      expect([first.status, other.status].sort()).toEqual([200, 201]);
      expect(first.body.id).toBe(other.body.id);
      expect(await prisma.biometricConsent.count({ where: { employeeId: worker.id } })).toBe(1);
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
