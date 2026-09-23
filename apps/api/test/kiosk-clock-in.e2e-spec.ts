import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '../src/common/ids.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONSENT_TEXT_SHA256 } from '../src/modules/attendance/consent-text.js';
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

/**
 * Clocking in at the kiosk, on a real database
 * (docs/plan/13-biometrics-design.md section 3): identify, confirm, "Not
 * me", and a supervisor's co-sign for the three kinds of worker who cannot
 * use their own face.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Clocking in at the kiosk (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let kiosk: TestDevice;
  let otherKiosk: TestDevice;
  let faces: FaceProvider;
  let adminToken = '';
  let supervisorToken = '';
  let supervisorStaffNumber = '';

  /** The supervisor's own face, enrolled once for every co-sign below. */
  const SUPERVISOR_FACE = 60.4;

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
  const api = () => request(app.getHttpServer());

  /** A flat face. Two levels 0.4 apart score about 0.27: plainly two people. */
  const faceAt = (level: number) => Array.from({ length: 1024 }, () => level);
  const sampleAt = (level: number, extra: Record<string, unknown> = {}) => ({
    model: 'human-faceres-1',
    embedding: faceAt(level),
    real: 0.9,
    live: 0.9,
    ...extra,
  });

  let starters = 0;
  const newWorker = async (status: 'ACTIVE' | 'PENDING_ENROLLMENT' = 'ACTIVE', postHere = true) => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    const worker = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-74${n.slice(1)}`,
        firstName: 'Clock',
        lastName: `Worker ${starters}`,
        phone: `+23320555${n}`,
        ghanaCardNumber: `GHA-5${n.padStart(8, '0')}-${starters % 10}`,
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

  /**
   * Gives a worker a face in use, the way an enrollment does, but straight
   * into the database: the enrollment route itself is pull request 4b's, and
   * going through it here would only spend this kiosk's rate limit.
   */
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

  const identify = (body: unknown, device: TestDevice = kiosk) =>
    signedPost(app, 'kiosk/identify', body, device);
  const confirm = (attemptId: string, device: TestDevice = kiosk) =>
    signedPost(app, 'kiosk/confirm', { attemptId }, device);

  /** A whole clock-in: look at the camera, then confirm the name shown. */
  const clockIn = async (level: number, direction: 'IN' | 'OUT' = 'IN') => {
    const seen = await identify({ purpose: 'CLOCK', direction, sample: sampleAt(level) });
    expect(seen.status).toBe(200);
    return { seen, punch: await confirm(seen.body.attemptId) };
  };

  const registerKiosk = async (name: string) => {
    const registered = await api()
      .post('/api/v1/devices')
      .set(...bearer(adminToken))
      .send({ name, siteId: company.siteA, kind: 'FACE_KIOSK' })
      .expect(201);
    return { id: registered.body.device.id, secret: registered.body.secret } as TestDevice;
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    faces = app.get(FaceProvider);

    const tokens = app.get(TokensService);
    adminToken = await tokens.signAccessToken({
      userId: company.adminUserId,
      companyId: company.companyId,
      role: 'ADMIN',
      employeeId: null,
      onKiosk: false,
    });
    supervisorToken = await tokens.signAccessToken({
      userId: company.supervisorUserId,
      companyId: company.companyId,
      role: 'SUPERVISOR',
      employeeId: company.supervisorEmployeeId,
      onKiosk: false,
    });
    kiosk = await registerKiosk('Gate kiosk');
    otherKiosk = await registerKiosk('Other gate kiosk');
    const supervisor = await prisma.employee.findUniqueOrThrow({
      where: { id: company.supervisorEmployeeId },
    });
    supervisorStaffNumber = supervisor.staffNumber;
    // The supervisor has a face like anybody else: it is how the kiosk knows
    // which supervisor is standing there.
    await giveFace(company.supervisorEmployeeId, SUPERVISOR_FACE);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('identify', () => {
    it('names the worker it recognises, and never how close anyone was', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 4.4);

      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(4.4),
      }).expect(200);

      expect(seen.body.outcome).toBe('MATCHED');
      expect(seen.body.worker.staffNumber).toBe(worker.staffNumber);
      // A shared screen never shows a full name.
      expect(seen.body.worker.displayName).toBe('Clock W.');
      expect(seen.body.fingerprint).toBeNull();
      // Not a score anywhere, under any name: the answers must never be
      // usable to feel a way towards somebody's stored face.
      expect(JSON.stringify(seen.body)).not.toMatch(/score|best|runnerUp|similar|0\.\d/i);
      // The attempt is written down whatever happens, with the numbers kept
      // on the server where they belong.
      const attempt = await prisma.clockInAttempt.findUniqueOrThrow({
        where: { id: seen.body.attemptId },
      });
      expect(attempt.outcome).toBe('MATCHED');
      expect(attempt.employeeId).toBe(worker.id);
      expect(attempt.thresholdVersion).toBe('ft-1');
      expect(attempt.bestScore).toBeGreaterThan(0.9);
    });

    it('will not tell two people apart by a hair, and records the failure', async () => {
      const twinOne = await newWorker();
      const twinTwo = await newWorker();
      await giveFace(twinOne.id, 8.4);
      // Close enough that the lead rule cannot separate them.
      await giveFace(twinTwo.id, 8.4);

      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(8.4),
      }).expect(200);

      expect(seen.body.outcome).toBe('AMBIGUOUS');
      expect(seen.body.worker).toBeNull();
      const attempt = await prisma.clockInAttempt.findUniqueOrThrow({
        where: { id: seen.body.attemptId },
      });
      expect(attempt.outcome).toBe('AMBIGUOUS');
      expect(attempt.employeeId).toBeNull();
    });

    it('recognises nobody when no face is close enough', async () => {
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(99),
      }).expect(200);

      expect(seen.body.outcome).toBe('NOT_RECOGNISED');
      expect(seen.body.worker).toBeNull();
    });

    it('refuses a face that did not look real or alive, before opening any face', async () => {
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(4.4, { live: 0.1 }),
      }).expect(200);

      expect(seen.body.outcome).toBe('LOW_LIVENESS');
      expect(seen.body.worker).toBeNull();
    });

    it('refuses a sample the contract does not allow at all', async () => {
      // A kiosk running the wrong model is a broken kiosk, and must never
      // be written down as a worker whose face did not look alive.
      const wrongModel = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(4.4, { model: 'some-other-model-2' }),
      });
      expect(wrongModel.status).toBe(400);
      const recorded = await prisma.clockInAttempt.count({
        where: { deviceId: kiosk.id, outcome: 'LOW_LIVENESS' },
      });
      expect(recorded).toBe(1);

      const wrongShape = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: { model: 'human-faceres-1', embedding: [1, 2, 3], real: 0.9, live: 0.9 },
      });
      expect(wrongShape.status).toBe(400);
    });

    it('is refused on any device that is not a face kiosk', async () => {
      const terminal = await api()
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Clock-in terminal', siteId: company.siteA, kind: 'ZKTECO' })
        .expect(201);

      const refused = await identify(
        { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(4.4) },
        { id: terminal.body.device.id, secret: terminal.body.secret },
      );

      expect(refused.status).toBe(401);
    });
  });

  describe('confirm', () => {
    it('records the punch, and answers DUPLICATE if the kiosk sends it again', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 12.4);

      const { seen, punch } = await clockIn(12.4);

      expect(punch.status).toBe(200);
      expect(punch.body.status).toBe('ACCEPTED');
      expect(punch.body.method).toBe('FACE');
      expect(punch.body.direction).toBe('IN');
      expect(punch.body.worker.staffNumber).toBe(worker.staffNumber);
      const stored = await prisma.punchEvent.findUniqueOrThrow({
        where: { id: punch.body.punchId },
      });
      // The punch is the attempt's own, at the server's time of the attempt:
      // a kiosk can never backdate a shift.
      expect(stored.deviceEventId).toBe(seen.body.attemptId);
      expect(stored.employeeId).toBe(worker.id);
      const attempt = await prisma.clockInAttempt.findUniqueOrThrow({
        where: { id: seen.body.attemptId },
      });
      expect(stored.deviceTime.toISOString()).toBe(attempt.attemptedAt.toISOString());

      const again = await confirm(seen.body.attemptId).expect(200);

      expect(again.body.status).toBe('DUPLICATE');
      expect(again.body.punchId).toBe(punch.body.punchId);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(1);
    });

    it('refuses an attempt that named nobody', async () => {
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(97),
      }).expect(200);

      const refused = await confirm(seen.body.attemptId).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
    });

    it('refuses an attempt from another kiosk', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 16.4);
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(16.4),
      }).expect(200);

      // The same attempt id, signed by a different kiosk.
      await confirm(seen.body.attemptId, otherKiosk).expect(409);

      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(0);
    });

    it('refuses a co-sign: a supervisor confirming somebody is never their own punch', async () => {
      const worker = await newWorker();
      const seen = await identify({
        purpose: 'CO_SIGN',
        staffNumber: worker.staffNumber,
        direction: 'IN',
        sample: sampleAt(SUPERVISOR_FACE),
      }).expect(200);
      expect(seen.body.outcome).toBe('MATCHED');

      await confirm(seen.body.attemptId).expect(409);

      expect(
        await prisma.punchEvent.count({ where: { employeeId: company.supervisorEmployeeId } }),
      ).toBe(0);
    });
  });

  describe('"Not me"', () => {
    it('cancels the match, so it can never become a punch', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 24.4);
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(24.4),
      }).expect(200);

      await signedPost(app, 'kiosk/not-me', { attemptId: seen.body.attemptId }, kiosk).expect(204);

      await confirm(seen.body.attemptId).expect(409);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(0);
      // Attempts never change, so the cancellation is a row of its own.
      const cancellation = await prisma.clockInAttempt.findFirstOrThrow({
        where: { cancelsAttemptId: seen.body.attemptId },
      });
      expect(cancellation.outcome).toBe('NOT_ME');
      expect(cancellation.purpose).toBe('CLOCK');
    });

    it('cannot be said twice about the same match', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 28.4);
      const seen = await identify({
        purpose: 'CLOCK',
        direction: 'IN',
        sample: sampleAt(28.4),
      }).expect(200);
      await signedPost(app, 'kiosk/not-me', { attemptId: seen.body.attemptId }, kiosk).expect(204);

      await signedPost(app, 'kiosk/not-me', { attemptId: seen.body.attemptId }, kiosk).expect(409);
    });
  });

  /**
   * The way in for the three kinds of worker who cannot use their own face.
   * The **server** decides which, because a kiosk standing at a gate must
   * never be able to tell a stranger who works where — so every refusal is
   * the same sentence.
   */
  describe('a supervisor co-signs', () => {
    /** The supervisor looks at the camera and types the worker's number. */
    const coSign = async (staffNumber: string, direction: 'IN' | 'OUT' = 'IN') => {
      const seen = await identify({
        purpose: 'CO_SIGN',
        staffNumber,
        direction,
        sample: sampleAt(SUPERVISOR_FACE),
      });
      expect(seen.status).toBe(200);
      expect(seen.body.outcome).toBe('MATCHED');
      // The answer names the supervisor, never the worker they typed.
      expect(seen.body.worker.staffNumber).toBe(supervisorStaffNumber);
      return seen.body.attemptId as string;
    };

    const assist = (coSignAttemptId: string, device: TestDevice = kiosk) =>
      signedPost(
        app,
        'kiosk/assisted-punches',
        { coSignAttemptId, reason: 'The camera cannot read this worker today.' },
        device,
      );

    /** Three failed face attempts in a row, which is what opens the fallback. */
    const failThreeTimes = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await identify({ purpose: 'CLOCK', direction: 'IN', sample: sampleAt(95) }).expect(200);
      }
    };

    it('records one flagged punch for a worker an exemption covers', async () => {
      const worker = await newWorker();
      await prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          reason: 'DECLINED',
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

      // No face scan for this worker, and no unlock needed: asking somebody
      // who refused biometrics to face a camera would undo the refusal.
      const punch = await assist(await coSign(worker.staffNumber)).expect(200);

      expect(punch.body.status).toBe('ACCEPTED');
      expect(punch.body.method).toBe('PIN_FALLBACK');
      expect(punch.body.worker.staffNumber).toBe(worker.staffNumber);
      const stored = await prisma.punchEvent.findUniqueOrThrow({
        where: { id: punch.body.punchId },
      });
      expect(stored.employeeId).toBe(worker.id);
      // Flagged, so payroll and the dashboard both show it differently.
      expect(stored.method).toBe('PIN_FALLBACK');
    });

    it('is used up by its first punch, on its own kiosk only', async () => {
      const worker = await newWorker();
      await prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          reason: 'DECLINED',
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
      const attemptId = await coSign(worker.staffNumber);

      const first = await assist(attemptId).expect(200);
      const again = await assist(attemptId).expect(200);
      const elsewhere = await assist(attemptId, otherKiosk).expect(409);

      expect(first.body.status).toBe('ACCEPTED');
      // One co-sign is one punch, however many times it is sent.
      expect(again.body.status).toBe('DUPLICATE');
      expect(again.body.punchId).toBe(first.body.punchId);
      expect(elsewhere.body.detail).toMatch(/Ask your supervisor/);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(1);
    });

    it('records a worker waiting for a withdrawal, and the punch raises a question', async () => {
      // Their face is gone and a second ADMIN owes them an answer: they keep
      // working meanwhile, and are paid once it is approved.
      const worker = await newWorker('PENDING_ENROLLMENT');
      await prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          reason: 'CONSENT_WITHDRAWN',
          requestedByUserId: company.adminUserId,
        },
      });

      const punch = await assist(await coSign(worker.staffNumber)).expect(200);

      expect(punch.body.status).toBe('ACCEPTED');
      const raised = await prisma.attendanceException.findFirst({
        where: { employeeId: worker.id, type: 'INACTIVE_EMPLOYEE' },
      });
      expect(raised).not.toBeNull();
    });

    it('refuses a worker who is simply waiting to be enrolled', async () => {
      const worker = await newWorker('PENDING_ENROLLMENT');

      const refused = await assist(await coSign(worker.staffNumber)).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(0);
    });

    it('refuses a worker posted to another site, in the same words', async () => {
      const elsewhere = await newWorker('ACTIVE', false);
      await prisma.siteAssignment.create({
        data: {
          companyId: company.companyId,
          employeeId: elsewhere.id,
          siteId: company.siteB,
          startsOn: new Date('2026-01-05T00:00:00Z'),
        },
      });

      const refused = await assist(await coSign(elsewhere.staffNumber)).expect(409);

      // The same sentence as every other refusal: a kiosk can never be used
      // to find out who works where.
      expect(refused.body.detail).toMatch(/Ask your supervisor/);
    });

    it('refuses a staff number that belongs to nobody', async () => {
      const refused = await assist(await coSign('SMT-99999')).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
    });

    it('spends one run of three failures on one worker, not on a queue of them', async () => {
      // The insider's move: scan the supervisor for several absent workers
      // first, then make the kiosk fail three times, then cash every scan in.
      const ownKiosk = await registerKiosk('Spent unlock kiosk');
      const first = await newWorker();
      const second = await newWorker();
      await giveFace(first.id, 64.4);
      await giveFace(second.id, 68.4);
      const scan = async (staffNumber: string) => {
        const seen = await signedPost(
          app,
          'kiosk/identify',
          {
            purpose: 'CO_SIGN',
            staffNumber,
            direction: 'IN',
            sample: sampleAt(SUPERVISOR_FACE),
          },
          ownKiosk,
        ).expect(200);
        return seen.body.attemptId as string;
      };
      const scanOne = await scan(first.staffNumber);
      const scanTwo = await scan(second.staffNumber);
      for (let n = 0; n < 3; n += 1) {
        await signedPost(
          app,
          'kiosk/identify',
          { purpose: 'CLOCK', direction: 'IN', sample: sampleAt(93) },
          ownKiosk,
        ).expect(200);
      }
      const spend = (attemptId: string) =>
        signedPost(
          app,
          'kiosk/assisted-punches',
          { coSignAttemptId: attemptId, reason: 'The camera will not read them today.' },
          ownKiosk,
        );

      // Both scans were taken **before** the failures, so neither of them is
      // a supervisor stepping in after a worker struggled.
      await spend(scanOne).expect(409);
      await spend(scanTwo).expect(409);

      expect(
        await prisma.punchEvent.count({ where: { employeeId: { in: [first.id, second.id] } } }),
      ).toBe(0);
    });

    it('needs three failed face attempts before it will help a worker who has a face', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 40.4);

      // Nothing has failed yet, so the face is the way in, not the supervisor.
      const tooSoon = await assist(await coSign(worker.staffNumber)).expect(409);
      expect(tooSoon.body.detail).toMatch(/Ask your supervisor/);

      await failThreeTimes();
      const punch = await assist(await coSign(worker.staffNumber)).expect(200);

      expect(punch.body.status).toBe('ACCEPTED');
      expect(punch.body.method).toBe('PIN_FALLBACK');
    });

    it('never lets a supervisor co-sign for themselves', async () => {
      const refused = await assist(await coSign(supervisorStaffNumber)).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
    });
  });

  /**
   * What the dashboard reads while a shift changes: the punches as they
   * arrive, and what the kiosks were asked along the way.
   */
  describe('the live board', () => {
    const board = (token: string, query = '') =>
      api()
        .get(`/api/v1/attendance/punches${query}`)
        .set(...bearer(token));

    it('shows punches newest first, by the time the API received them', async () => {
      const first = await newWorker();
      const second = await newWorker();
      await giveFace(first.id, 44.4);
      await giveFace(second.id, 48.4);
      const older = await clockIn(44.4);
      const newer = await clockIn(48.4, 'OUT');
      expect(older.punch.status).toBe(200);
      expect(newer.punch.status).toBe(200);

      const shown = await board(adminToken, '?limit=5').expect(200);

      const ids = shown.body.items.map((item: { id: string }) => item.id);
      expect(ids.indexOf(newer.punch.body.punchId)).toBeLessThan(
        ids.indexOf(older.punch.body.punchId),
      );
      const top = shown.body.items.find(
        (item: { id: string }) => item.id === newer.punch.body.punchId,
      );
      expect(top.employee.staffNumber).toBe(second.staffNumber);
      expect(top.direction).toBe('OUT');
      expect(top.method).toBe('FACE');
      expect(top.deviceName).toBe('Gate kiosk');
      expect(top.siteId).toBe(company.siteA);
      // A board is a read: never a score, and never anything about a face.
      expect(JSON.stringify(shown.body)).not.toMatch(/score|embedding|template/i);
    });

    it('shows a supervisor their own sites, and nobody else’s', async () => {
      const mine = await board(supervisorToken, `?siteId=${company.siteA}`).expect(200);
      expect(mine.body.items.length).toBeGreaterThan(0);

      // Site B is not this supervisor's, so it is not theirs to look at.
      await board(supervisorToken, `?siteId=${company.siteB}`).expect(404);
    });

    it('is not for a guard', async () => {
      const guard = await app.get(TokensService).signAccessToken({
        userId: company.guardUserId,
        companyId: company.companyId,
        role: 'GUARD',
        employeeId: company.active.id,
        onKiosk: false,
      });

      await board(guard).expect(403);
    });

    it('keeps every attempt, successes and failures alike, without a score', async () => {
      const attempts = await api()
        .get('/api/v1/attendance/clock-in-attempts?limit=50')
        .set(...bearer(adminToken))
        .expect(200);

      const outcomes = attempts.body.items.map((item: { outcome: string }) => item.outcome);
      expect(outcomes).toContain('MATCHED');
      expect(outcomes).toContain('NOT_RECOGNISED');
      expect(outcomes).toContain('NOT_ME');
      // The one thing a probing attacker would want is the one thing the
      // list never carries.
      expect(JSON.stringify(attempts.body)).not.toMatch(/score|embedding/i);
      const confirmed = attempts.body.items.find(
        (item: { outcome: string; punchId: string | null }) =>
          item.outcome === 'MATCHED' && item.punchId !== null,
      );
      // An attempt never changes, so its punch is found by the id they share.
      expect(confirmed).toBeDefined();
      const coSign = attempts.body.items.find(
        (item: { purpose: string }) => item.purpose === 'CO_SIGN',
      );
      expect(coSign.staffNumberTried).toMatch(/^SMT-\d{5}$/);
      expect(coSign.employee.staffNumber).toBe(supervisorStaffNumber);
    });

    it('is not for HR either: the attempt log is an ADMIN’s to read', async () => {
      const hr = await app.get(TokensService).signAccessToken({
        userId: company.hrUserId,
        companyId: company.companyId,
        role: 'HR_PAYROLL',
        employeeId: null,
        onKiosk: false,
      });

      await api()
        .get('/api/v1/attendance/clock-in-attempts')
        .set(...bearer(hr))
        .expect(403);
    });
  });

  /**
   * The two clocks the design leans on: an identification is good for a
   * minute, and a run of failures only unlocks the fallback while it is
   * fresh. Attempts are append-only, so an old one is written as an old one
   * rather than aged afterwards.
   */
  describe('the time limits', () => {
    const attemptFrom = async (
      employeeId: string,
      secondsAgo: number,
      outcome: 'MATCHED' | 'NOT_RECOGNISED' = 'MATCHED',
    ) =>
      prisma.clockInAttempt.create({
        data: {
          companyId: company.companyId,
          deviceId: kiosk.id,
          purpose: 'CLOCK',
          direction: 'IN',
          outcome,
          employeeId: outcome === 'MATCHED' ? employeeId : null,
          thresholdVersion: 'ft-1',
          attemptedAt: new Date(Date.now() - secondsAgo * 1000),
        },
        select: { id: true },
      });

    it('will not confirm an identification more than a minute old', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 52.4);
      const stale = await attemptFrom(worker.id, 61);

      const refused = await confirm(stale.id).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(0);

      // A minute younger, and the same call works.
      const fresh = await attemptFrom(worker.id, 5);
      const punch = await confirm(fresh.id).expect(200);
      expect(punch.body.status).toBe('ACCEPTED');
    });

    it('will not unlock the fallback on failures that have gone cold', async () => {
      const worker = await newWorker();
      await giveFace(worker.id, 56.4);
      const staleKiosk = await registerKiosk('Cold failures kiosk');
      // Three failures, but they happened five minutes ago: whoever was
      // struggling then has long since walked away.
      for (let n = 0; n < 3; n += 1) {
        await prisma.clockInAttempt.create({
          data: {
            companyId: company.companyId,
            deviceId: staleKiosk.id,
            purpose: 'CLOCK',
            direction: 'IN',
            outcome: 'NOT_RECOGNISED',
            thresholdVersion: 'ft-1',
            attemptedAt: new Date(Date.now() - (300 + n) * 1000),
          },
        });
      }
      const seen = await signedPost(
        app,
        'kiosk/identify',
        {
          purpose: 'CO_SIGN',
          staffNumber: worker.staffNumber,
          direction: 'IN',
          sample: sampleAt(SUPERVISOR_FACE),
        },
        staleKiosk,
      ).expect(200);

      const refused = await signedPost(
        app,
        'kiosk/assisted-punches',
        { coSignAttemptId: seen.body.attemptId, reason: 'Trying an old run of failures.' },
        staleKiosk,
      ).expect(409);

      expect(refused.body.detail).toMatch(/Ask your supervisor/);
      expect(await prisma.punchEvent.count({ where: { employeeId: worker.id } })).toBe(0);
    });
  });

  describe('one company never sees another', () => {
    it('keeps punches and attempts inside the company that made them', async () => {
      const other = await createAttendanceCompany(prisma);
      const outsider = await app.get(TokensService).signAccessToken({
        userId: other.adminUserId,
        companyId: other.companyId,
        role: 'ADMIN',
        employeeId: null,
        onKiosk: false,
      });

      const punches = await api()
        .get('/api/v1/attendance/punches?limit=100')
        .set(...bearer(outsider))
        .expect(200);
      const attempts = await api()
        .get('/api/v1/attendance/clock-in-attempts?limit=100')
        .set(...bearer(outsider))
        .expect(200);

      // This company has done nothing, and sees nothing — not one row of
      // the busy company next door.
      expect(punches.body.items).toEqual([]);
      expect(attempts.body.items).toEqual([]);
      // And the other way round: asking for their site by id is a 404, not
      // a peek.
      await api()
        .get(`/api/v1/attendance/punches?siteId=${other.siteA}`)
        .set(...bearer(adminToken))
        .expect(404);
    });
  });
});
