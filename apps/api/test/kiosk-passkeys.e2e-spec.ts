import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '../src/common/ids.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONSENT_TEXT_SHA256 } from '../src/modules/attendance/consent-text.js';
import { type SignedRoute, signRequest } from '../src/modules/attendance/device-signature.js';
import { FaceProvider } from '../src/modules/attendance/face-provider.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  signedPost,
  type TestDevice,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';
import { FakeAuthenticator } from './fake-authenticator.js';

/**
 * The finger, on the kiosk's own sensor (docs/plan/13 section 4): saving a
 * key, the face-then-finger clock-in, and the staff-number fallback.
 *
 * The answers here are real WebAuthn: `FakeAuthenticator` builds the same
 * bytes a real sensor would and signs them, so what these tests check is the
 * verification itself, not a stand-in for it.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

/** The kiosk address the test app is configured with (`create-db-test-app.ts`). */
const KIOSK_ORIGIN = 'http://localhost:5174';
const RELYING_PARTY = 'localhost';

describe.skipIf(!databaseUrl)('Fingerprints on the kiosk (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let kiosk: TestDevice;
  let faces: FaceProvider;
  let adminToken = '';
  let adminOnKiosk = '';

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
  const api = () => request(app.getHttpServer());

  const faceAt = (level: number) => Array.from({ length: 1024 }, () => level);
  const sampleAt = (level: number) => ({
    model: 'human-faceres-1',
    embedding: faceAt(level),
    real: 0.9,
    live: 0.9,
  });

  /** An ADMIN's route on the kiosk: the token **and** the device's signature. */
  const operatorPost = (route: SignedRoute, body: unknown, device: TestDevice) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = JSON.stringify(body);
    return api()
      .post(`/api/v1/${route}`)
      .set('Content-Type', 'application/json')
      .set(...bearer(adminOnKiosk))
      .set('X-Samtec-Device', device.id)
      .set('X-Samtec-Timestamp', timestamp)
      .set('X-Samtec-Signature', signRequest(device.secret, timestamp, route, text))
      .send(text);
  };

  /** A kiosk with its fingerprint sensor switched on, as an ADMIN sets it up. */
  const registerKiosk = async (name: string) => {
    const registered = await api()
      .post('/api/v1/devices')
      .set(...bearer(adminToken))
      .send({ name, siteId: company.siteA, kind: 'FACE_KIOSK' })
      .expect(201);
    await api()
      .patch(`/api/v1/devices/${registered.body.device.id}`)
      .set(...bearer(adminToken))
      .send({ passkeysEnabled: true })
      .expect(200);
    return { id: registered.body.device.id, secret: registered.body.secret } as TestDevice;
  };

  let starters = 0;
  const newWorker = async (status: 'ACTIVE' | 'PENDING_ENROLLMENT' = 'ACTIVE', postHere = true) => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    const worker = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-75${n.slice(1)}`,
        firstName: 'Finger',
        lastName: `Worker ${starters}`,
        phone: `+23320556${n}`,
        ghanaCardNumber: `GHA-6${n.padStart(8, '0')}-${starters % 10}`,
        position: 'Security Guard',
        status,
        hireDate: new Date('2026-01-05T00:00:00Z'),
      },
    });
    if (postHere) {
      await prisma.siteAssignment.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          siteId: company.siteA,
          startsOn: new Date('2026-01-05T00:00:00Z'),
        },
      });
    }
    return worker;
  };

  /** A face in use, written straight in: the enrollment route is tested elsewhere. */
  const giveFace = async (employeeId: string, level: number) => {
    const consent = await prisma.biometricConsent.create({
      data: {
        companyId: company.companyId,
        employeeId,
        status: 'GIVEN',
        textVersion: 'bio-v1',
        textSha256: CONSENT_TEXT_SHA256,
        recordedByUserId: company.adminUserId,
        deviceId: kiosk.id,
      },
    });
    const credentialId = newUuidV7();
    await prisma.biometricCredential.create({
      data: {
        id: credentialId,
        companyId: company.companyId,
        employeeId,
        kind: 'FACE',
        deviceId: kiosk.id,
        templateSealed: new Uint8Array(
          faces.seal(faceAt(level), { companyId: company.companyId, employeeId, credentialId }),
        ),
        keyVersion: faces.keyVersion,
        faceModel: faces.model,
        consentId: consent.id,
        enrolledByUserId: company.adminUserId,
        dedupe: 'PASSED',
        status: 'ACTIVE',
      },
    });
    await prisma.employee.update({
      where: { id: employeeId },
      data: { biometricEnrolledAt: new Date() },
    });
  };

  /**
   * The whole registration: ask the kiosk for options, let its sensor make a
   * key, and save it. Answers the sensor, so a test can use it again later.
   */
  const saveFinger = async (
    employeeId: string,
    device: TestDevice = kiosk,
    options: { synced?: boolean } = {},
  ) => {
    const asked = await operatorPost('kiosk/passkey-options', { employeeId }, device).expect(200);
    const sensor = new FakeAuthenticator(RELYING_PARTY, KIOSK_ORIGIN, options.synced ?? false);
    const saved = await operatorPost(
      'kiosk/passkeys',
      {
        employeeId,
        ticket: asked.body.ticket,
        response: sensor.register(asked.body.options.challenge),
      },
      device,
    ).expect(201);
    return { sensor, saved: saved.body, asked: asked.body };
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    faces = app.get(FaceProvider);

    const tokens = app.get(TokensService);
    const sign = (onKiosk: boolean) =>
      tokens.signAccessToken({
        userId: company.adminUserId,
        companyId: company.companyId,
        role: 'ADMIN',
        employeeId: null,
        onKiosk,
      });
    adminToken = await sign(false);
    adminOnKiosk = await sign(true);
    kiosk = await registerKiosk('Finger kiosk');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('saving a finger', () => {
    it('keeps the public half, the device and who saved it — and never a finger', async () => {
      const own = await registerKiosk('Save a finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 10.4);

      const { saved, sensor } = await saveFinger(worker.id, own);

      expect(saved.deviceId).toBe(own.id);
      expect(saved.synced).toBe(false);
      expect(saved.revokedAt).toBeNull();
      const key = await prisma.devicePasskey.findUniqueOrThrow({ where: { id: saved.id } });
      expect(key.credentialId).toBe(sensor.credentialId);
      expect(key.employeeId).toBe(worker.id);
      expect(key.registeredByUserId).toBe(company.adminUserId);
      // The public half is a key, not a fingerprint: the finger never leaves
      // the device, and nothing here could rebuild one.
      expect(key.publicKey.length).toBeGreaterThan(20);
      const audited = await prisma.auditLog.findFirst({
        where: { action: 'biometric.passkey_registered', entityId: worker.id },
      });
      expect(audited).not.toBeNull();
    });

    it('records a key the device may copy to its cloud account', async () => {
      const own = await registerKiosk('Synced finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 11.4);

      const { saved } = await saveFinger(worker.id, own, { synced: true });

      // The report has to say so: a synced key can exist on hardware nobody
      // at the gate has ever seen.
      expect(saved.synced).toBe(true);
    });

    it('replaces the key this worker already had on this kiosk', async () => {
      const own = await registerKiosk('Replace a finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 12.4);
      const first = await saveFinger(worker.id, own);

      const second = await saveFinger(worker.id, own);

      const keys = await prisma.devicePasskey.findMany({
        where: { employeeId: worker.id, deviceId: own.id },
        orderBy: { registeredAt: 'asc' },
      });
      expect(keys).toHaveLength(2);
      expect(keys[0]?.credentialId).toBe(first.sensor.credentialId);
      expect(keys[0]?.revokedAt).not.toBeNull();
      expect(keys[1]?.credentialId).toBe(second.sensor.credentialId);
      expect(keys[1]?.revokedAt).toBeNull();
    });

    it('refuses a ticket meant for somebody else, and one that was changed', async () => {
      const own = await registerKiosk('Wrong ticket kiosk');
      const worker = await newWorker();
      const somebodyElse = await newWorker();
      await giveFace(worker.id, 13.4);
      await giveFace(somebodyElse.id, 14.4);
      const asked = await operatorPost(
        'kiosk/passkey-options',
        { employeeId: worker.id },
        own,
      ).expect(200);
      const sensor = new FakeAuthenticator(RELYING_PARTY, KIOSK_ORIGIN);
      const answer = sensor.register(asked.body.options.challenge);
      const ticket: string = asked.body.ticket;
      const changed = `${ticket.slice(0, 20)}${ticket[20] === 'A' ? 'B' : 'A'}${ticket.slice(21)}`;

      await operatorPost(
        'kiosk/passkeys',
        { employeeId: somebodyElse.id, ticket, response: answer },
        own,
      ).expect(409);
      await operatorPost(
        'kiosk/passkeys',
        { employeeId: worker.id, ticket: changed, response: answer },
        own,
      ).expect(409);
      expect(await prisma.devicePasskey.count({ where: { deviceId: own.id } })).toBe(0);
    });

    it('refuses a key the kiosk made without asking for a finger', async () => {
      const own = await registerKiosk('No finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 15.4);
      const asked = await operatorPost(
        'kiosk/passkey-options',
        { employeeId: worker.id },
        own,
      ).expect(200);
      const sensor = new FakeAuthenticator(RELYING_PARTY, KIOSK_ORIGIN);

      // The screen was unlocked, but no finger was checked.
      await operatorPost(
        'kiosk/passkeys',
        {
          employeeId: worker.id,
          ticket: asked.body.ticket,
          response: sensor.register(asked.body.options.challenge, { userVerified: false }),
        },
        own,
      ).expect(409);
      expect(await prisma.devicePasskey.count({ where: { deviceId: own.id } })).toBe(0);
    });

    it('refuses a worker with no face in use', async () => {
      const own = await registerKiosk('No face kiosk');
      const worker = await newWorker();

      await operatorPost('kiosk/passkey-options', { employeeId: worker.id }, own).expect(409);
    });

    it('needs the ADMIN as well as the kiosk', async () => {
      const own = await registerKiosk('Signature only kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 16.4);

      // The kiosk's signature alone: no token, no registration.
      await signedPost(app, 'kiosk/passkey-options', { employeeId: worker.id }, own).expect(401);
    });
  });

  describe('the face, then the finger', () => {
    it('asks for the finger and marks the punch FACE_PASSKEY', async () => {
      const own = await registerKiosk('Face then finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 20.4);
      const { sensor } = await saveFinger(worker.id, own);

      const seen = await signedPost(
        app,
        'kiosk/identify',
        { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(20.4) },
        own,
      ).expect(200);
      expect(seen.body.outcome).toBe('MATCHED');
      expect(seen.body.fingerprint.options.challenge).toEqual(expect.any(String));
      const punched = await signedPost(
        app,
        'kiosk/confirm',
        {
          attemptId: seen.body.attemptId,
          assertion: sensor.authenticate(seen.body.fingerprint.options.challenge),
        },
        own,
      ).expect(200);

      expect(punched.body.method).toBe('FACE_PASSKEY');
      const punch = await prisma.punchEvent.findUniqueOrThrow({
        where: { id: punched.body.punchId },
      });
      expect(punch.method).toBe('FACE_PASSKEY');
      // The finger was used: the key's counter moved on.
      const key = await prisma.devicePasskey.findFirstOrThrow({
        where: { employeeId: worker.id, deviceId: own.id },
      });
      expect(key.lastUsedAt).not.toBeNull();
      expect(Number(key.signCount)).toBeGreaterThan(0);
    });

    it('makes no punch at all when the finger is refused or skipped', async () => {
      const own = await registerKiosk('Refused finger kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 21.4);
      const { sensor } = await saveFinger(worker.id, own);
      const ask = async () =>
        (
          await signedPost(
            app,
            'kiosk/identify',
            { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(21.4) },
            own,
          ).expect(200)
        ).body;

      // Cancelled at the sensor: a quieter punch is never the answer.
      const first = await ask();
      await signedPost(app, 'kiosk/confirm', { attemptId: first.attemptId }, own).expect(409);
      // Answered with somebody else's challenge.
      const second = await ask();
      const third = await ask();
      await signedPost(
        app,
        'kiosk/confirm',
        {
          attemptId: second.attemptId,
          assertion: sensor.authenticate(third.fingerprint.options.challenge),
        },
        own,
      ).expect(409);
      // Answered from another address, which is what a copied kiosk page is.
      const fourth = await ask();
      await signedPost(
        app,
        'kiosk/confirm',
        {
          attemptId: fourth.attemptId,
          assertion: sensor.authenticate(fourth.fingerprint.options.challenge, {
            origin: 'http://kiosk.example.test',
          }),
        },
        own,
      ).expect(409);

      expect(await prisma.punchEvent.count({ where: { deviceId: own.id } })).toBe(0);
    });

    it('refuses another worker’s finger, and a finger saved on another kiosk', async () => {
      const own = await registerKiosk('Wrong finger kiosk');
      const elsewhere = await registerKiosk('Elsewhere kiosk');
      const worker = await newWorker();
      const neighbour = await newWorker();
      await giveFace(worker.id, 22.4);
      await giveFace(neighbour.id, 26.4);
      await saveFinger(worker.id, own);
      const { sensor: neighboursFinger } = await saveFinger(neighbour.id, own);
      const { sensor: farAway } = await saveFinger(worker.id, elsewhere);

      const seen = await signedPost(
        app,
        'kiosk/identify',
        { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(22.4) },
        own,
      ).expect(200);
      const challenge = seen.body.fingerprint.options.challenge;

      await signedPost(
        app,
        'kiosk/confirm',
        { attemptId: seen.body.attemptId, assertion: neighboursFinger.authenticate(challenge) },
        own,
      ).expect(409);
      await signedPost(
        app,
        'kiosk/confirm',
        { attemptId: seen.body.attemptId, assertion: farAway.authenticate(challenge) },
        own,
      ).expect(409);
      expect(await prisma.punchEvent.count({ where: { deviceId: own.id } })).toBe(0);
    });

    it('carries on by face when this worker has no finger on this kiosk', async () => {
      const own = await registerKiosk('Face only kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 23.4);

      const seen = await signedPost(
        app,
        'kiosk/identify',
        { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(23.4) },
        own,
      ).expect(200);
      expect(seen.body.fingerprint).toBeNull();
      const punched = await signedPost(
        app,
        'kiosk/confirm',
        { attemptId: seen.body.attemptId },
        own,
      ).expect(200);

      expect(punched.body.method).toBe('FACE');
    });

    it('stops asking once an ADMIN switches the kiosk’s fingerprints off', async () => {
      const own = await registerKiosk('Switched off kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 24.4);
      await saveFinger(worker.id, own);

      await api()
        .patch(`/api/v1/devices/${own.id}`)
        .set(...bearer(adminToken))
        .send({ passkeysEnabled: false })
        .expect(200);

      const seen = await signedPost(
        app,
        'kiosk/identify',
        { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(24.4) },
        own,
      ).expect(200);
      expect(seen.body.fingerprint).toBeNull();
    });
  });

  describe('the staff number and a finger', () => {
    /** Three face attempts nobody matches, which is what opens the fallback. */
    const failThreeTimes = async (device: TestDevice) => {
      for (let n = 0; n < 3; n += 1) {
        await signedPost(
          app,
          'kiosk/identify',
          { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(500 + n) },
          device,
        ).expect(200);
      }
    };

    it('is shut until the kiosk has just failed three times, and writes nothing', async () => {
      const own = await registerKiosk('Shut fallback kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 30.4);
      await saveFinger(worker.id, own);

      await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: worker.staffNumber, direction: 'IN' },
        own,
      ).expect(409);

      // No attempt row: there was no unlock to use up.
      expect(
        await prisma.clockInAttempt.count({
          where: { deviceId: own.id, purpose: 'STAFF_PASSKEY' },
        }),
      ).toBe(0);
    });

    it('lets the worker in by staff number and finger, marked STAFF_PASSKEY', async () => {
      const own = await registerKiosk('Open fallback kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 31.4);
      const { sensor } = await saveFinger(worker.id, own);
      await failThreeTimes(own);

      const asked = await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: worker.staffNumber, direction: 'IN' },
        own,
      ).expect(200);
      expect(asked.body.worker.staffNumber).toBe(worker.staffNumber);
      const punched = await signedPost(
        app,
        'kiosk/confirm',
        {
          attemptId: asked.body.attemptId,
          assertion: sensor.authenticate(asked.body.options.challenge),
        },
        own,
      ).expect(200);

      // Any finger saved on this kiosk opens this key, so the punch is
      // marked apart and the ghost rules count it.
      expect(punched.body.method).toBe('STAFF_PASSKEY');
      const attempt = await prisma.clockInAttempt.findUniqueOrThrow({
        where: { id: asked.body.attemptId },
      });
      expect(attempt.outcome).toBe('FINGERPRINT_REQUESTED');
      expect(attempt.staffNumberTried).toBe(worker.staffNumber);
      expect(attempt.employeeId).toBe(worker.id);
    });

    it('uses the unlock up on a staff number that opens nothing', async () => {
      const own = await registerKiosk('Probed fallback kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 32.4);
      await saveFinger(worker.id, own);
      await failThreeTimes(own);

      // A number nobody here has: refused, and the run of three is spent.
      await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: 'SMT-99999', direction: 'IN' },
        own,
      ).expect(409);
      await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: worker.staffNumber, direction: 'IN' },
        own,
      ).expect(409);

      const refused = await prisma.clockInAttempt.findFirstOrThrow({
        where: { deviceId: own.id, purpose: 'STAFF_PASSKEY' },
      });
      expect(refused.outcome).toBe('FALLBACK_REFUSED');
      expect(refused.staffNumberTried).toBe('SMT-99999');
      expect(refused.employeeId).toBeNull();
      expect(
        await prisma.clockInAttempt.count({
          where: { deviceId: own.id, purpose: 'STAFF_PASSKEY' },
        }),
      ).toBe(1);
    });

    it('says the same thing about a worker with no finger on this kiosk', async () => {
      const own = await registerKiosk('No finger fallback kiosk');
      const worker = await newWorker();
      await giveFace(worker.id, 33.4);
      await failThreeTimes(own);

      const refused = await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: worker.staffNumber, direction: 'IN' },
        own,
      ).expect(409);

      // The same answer as an unknown number: a kiosk must not be usable to
      // learn who works here (docs/plan/13 §3).
      expect(refused.body.detail).toMatch(/Ask your supervisor/);
      const attempt = await prisma.clockInAttempt.findFirstOrThrow({
        where: { deviceId: own.id, purpose: 'STAFF_PASSKEY' },
      });
      expect(attempt.outcome).toBe('FALLBACK_REFUSED');
      expect(attempt.employeeId).toBeNull();
    });

    it('refuses a worker who is not posted to this kiosk’s site', async () => {
      const own = await registerKiosk('Elsewhere fallback kiosk');
      const worker = await newWorker('ACTIVE', false);
      await giveFace(worker.id, 34.4);
      await saveFinger(worker.id, own);
      await failThreeTimes(own);

      await signedPost(
        app,
        'kiosk/fingerprint-options',
        { staffNumber: worker.staffNumber, direction: 'IN' },
        own,
      ).expect(409);
    });
  });

  describe('a supervisor’s co-sign', () => {
    it('asks the supervisor for their own finger when they have one here', async () => {
      const own = await registerKiosk('Co-sign finger kiosk');
      const worker = await newWorker();
      // An exemption always starts as a request and is approved by a second
      // ADMIN afterwards (a database trigger insists on it).
      await prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          reason: 'CANNOT_ENROLL',
          requestedByUserId: company.adminUserId,
        },
      });
      await prisma.biometricExemption.updateMany({
        where: { employeeId: worker.id },
        data: {
          status: 'APPROVED',
          reviewedByUserId: company.secondAdminUserId,
          reviewedAt: new Date(),
          reviewNote: 'Ghana Card checked in person.',
        },
      });
      await giveFace(company.supervisorEmployeeId, 40.4);
      const { sensor } = await saveFinger(company.supervisorEmployeeId, own);

      const scan = await signedPost(
        app,
        'kiosk/identify',
        {
          purpose: 'CO_SIGN',
          staffNumber: worker.staffNumber,
          direction: 'IN',
          sample: sampleAt(40.4),
        },
        own,
      ).expect(200);
      expect(scan.body.fingerprint.options.challenge).toEqual(expect.any(String));

      // Without the finger the co-sign is refused outright.
      await signedPost(
        app,
        'kiosk/assisted-punches',
        { coSignAttemptId: scan.body.attemptId, reason: 'Exempt from biometrics' },
        own,
      ).expect(409);
      const punched = await signedPost(
        app,
        'kiosk/assisted-punches',
        {
          coSignAttemptId: scan.body.attemptId,
          assertion: sensor.authenticate(scan.body.fingerprint.options.challenge),
          reason: 'Exempt from biometrics',
        },
        own,
      ).expect(200);

      expect(punched.body.method).toBe('PIN_FALLBACK');
      expect(punched.body.worker.staffNumber).toBe(worker.staffNumber);
    });
  });
});
