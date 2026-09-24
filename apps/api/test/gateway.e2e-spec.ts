import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONSENT_TEXT_SHA256 } from '../src/modules/attendance/consent-text.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import {
  type AttendanceCompany,
  activateDevice,
  createAttendanceCompany,
  signedPost,
  type TestDevice,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The ZKTeco gateway's two routes, and the window an ADMIN opens for a finger
 * (docs/plan/13-biometrics-design.md section 5).
 *
 * The rule under test throughout: **a terminal never enrolls anybody by
 * itself.** A finger counts only inside a window an ADMIN opened; everything
 * else is written down and raised, never quietly accepted.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('The ZKTeco gateway (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let adminToken = '';
  /** Consent is always recorded on a face kiosk (a database trigger says so). */
  let consentKiosk = '';

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
  const api = () => request(app.getHttpServer());

  /** A ZKTeco terminal, as an ADMIN registers one. */
  const registerTerminal = async (name: string, siteId = company.siteA) => {
    const registered = await api()
      .post('/api/v1/devices')
      .set(...bearer(adminToken))
      .send({ name, siteId, kind: 'ZKTECO' })
      .expect(201);
    await activateDevice(app, company, registered.body.device.id);
    return { id: registered.body.device.id, secret: registered.body.secret } as TestDevice;
  };

  let starters = 0;
  const newWorker = async (
    options: { status?: 'ACTIVE' | 'PENDING_ENROLLMENT'; siteId?: string; consent?: boolean } = {},
  ) => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    const worker = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-76${n.slice(1)}`,
        firstName: 'Terminal',
        lastName: `Worker ${starters}`,
        phone: `+23320557${n}`,
        ghanaCardNumber: `GHA-7${n.padStart(8, '0')}-${starters % 10}`,
        position: 'Security Guard',
        status: options.status ?? 'ACTIVE',
        hireDate: new Date('2026-01-05T00:00:00Z'),
      },
    });
    if (options.siteId !== null) {
      await prisma.siteAssignment.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          siteId: options.siteId ?? company.siteA,
          startsOn: new Date('2026-01-05T00:00:00Z'),
        },
      });
    }
    if (options.consent !== false) {
      await prisma.biometricConsent.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          status: 'GIVEN',
          textVersion: 'bio-v1',
          textSha256: CONSENT_TEXT_SHA256,
          recordedByUserId: company.adminUserId,
          deviceId: consentKiosk,
        },
      });
    }
    return worker;
  };

  const openWindow = (device: TestDevice, employeeId: string) =>
    api()
      .post(`/api/v1/devices/${device.id}/finger-enrollment-windows`)
      .set(...bearer(adminToken))
      .send({ employeeId });

  const report = (device: TestDevice, enrollments: unknown[]) =>
    signedPost(app, 'ingest/enrollments', { enrollments }, device);

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    adminToken = await app.get(TokensService).signAccessToken({
      userId: company.adminUserId,
      companyId: company.companyId,
      role: 'ADMIN',
      employeeId: null,
      onKiosk: false,
    });
    const kiosk = await api()
      .post('/api/v1/devices')
      .set(...bearer(adminToken))
      .send({ name: 'Consent kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
      .expect(201);
    await activateDevice(app, company, kiosk.body.device.id);
    consentKiosk = kiosk.body.device.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('the roster', () => {
    it('lists who belongs on this terminal, and nothing about them', async () => {
      const terminal = await registerTerminal('Roster terminal');
      const here = await newWorker();
      const waiting = await newWorker({ status: 'PENDING_ENROLLMENT' });
      const elsewhere = await newWorker({ siteId: company.siteB });

      const roster = await signedPost(app, 'ingest/roster', {}, terminal).expect(200);

      const numbers = roster.body.users.map((user: { staffNumber: string }) => user.staffNumber);
      expect(numbers).toContain(here.staffNumber);
      // Waiting to be enrolled is exactly who a terminal needs to know about.
      expect(numbers).toContain(waiting.staffNumber);
      expect(numbers).not.toContain(elsewhere.staffNumber);
      // A terminal at a gate is read by whoever walks past it.
      const mine = roster.body.users.find(
        (user: { staffNumber: string }) => user.staffNumber === here.staffNumber,
      );
      expect(mine.displayName).toBe('Terminal W.');
      expect(JSON.stringify(roster.body)).not.toMatch(/GHA-|template|embedding/i);
    });

    it('leaves out a worker blocked as a duplicate, so their fingers come off too', async () => {
      const terminal = await registerTerminal('Blocked roster terminal');
      const worker = await newWorker();
      await prisma.biometricCredential.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          kind: 'TERMINAL_FINGER',
          deviceId: terminal.id,
          dedupe: 'NOT_CHECKED',
          status: 'BLOCKED',
          wipedAt: new Date(),
        },
      });

      const roster = await signedPost(app, 'ingest/roster', {}, terminal).expect(200);

      expect(
        roster.body.users.map((user: { staffNumber: string }) => user.staffNumber),
      ).not.toContain(worker.staffNumber);
    });

    it('is refused on a kiosk, because a kiosk has no roster', async () => {
      const kiosk = await api()
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Roster kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      await activateDevice(app, company, kiosk.body.device.id);

      await signedPost(
        app,
        'ingest/roster',
        {},
        {
          id: kiosk.body.device.id,
          secret: kiosk.body.secret,
        },
      ).expect(401);
    });
  });

  describe('the window an ADMIN opens', () => {
    it('opens for 30 minutes, and a second one closes the first', async () => {
      const terminal = await registerTerminal('Window terminal');
      const worker = await newWorker();

      const first = await openWindow(terminal, worker.id).expect(201);
      const minutes = (Date.parse(first.body.expiresAt) - Date.parse(first.body.opensAt)) / 60_000;
      expect(minutes).toBeCloseTo(30, 5);
      expect(first.body.staffNumber).toBe(worker.staffNumber);

      const second = await openWindow(terminal, worker.id).expect(201);

      const windows = await prisma.fingerEnrollmentWindow.findMany({
        where: { deviceId: terminal.id, employeeId: worker.id },
        orderBy: { opensAt: 'asc' },
      });
      expect(windows).toHaveLength(2);
      // An ADMIN who taps twice never leaves two open.
      expect(windows[0]?.expiresAt.getTime()).toBeLessThanOrEqual(Date.parse(second.body.opensAt));
    });

    it('refuses a kiosk, a worker posted elsewhere, and a worker who never agreed', async () => {
      const terminal = await registerTerminal('Refusing window terminal');
      const kiosk = await api()
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Window kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      await activateDevice(app, company, kiosk.body.device.id);
      const posted = await newWorker();
      const elsewhere = await newWorker({ siteId: company.siteB });
      const noConsent = await newWorker({ consent: false });

      await api()
        .post(`/api/v1/devices/${kiosk.body.device.id}/finger-enrollment-windows`)
        .set(...bearer(adminToken))
        .send({ employeeId: posted.id })
        .expect(409);
      await openWindow(terminal, elsewhere.id).expect(409);
      // A finger is biometric data like any other: no consent, no enrollment.
      await openWindow(terminal, noConsent.id).expect(409);
    });
  });

  describe('a finger a terminal reports', () => {
    it('is taken only inside a window, and the window is then spent', async () => {
      const terminal = await registerTerminal('Enrolling terminal');
      const worker = await newWorker();
      await openWindow(terminal, worker.id).expect(201);
      const enrolledAt = new Date().toISOString();

      const accepted = await report(terminal, [
        { deviceUserRef: worker.staffNumber, fingerIndex: 1, enrolledAt },
      ]).expect(200);

      expect(accepted.body.results[0].status).toBe('ACCEPTED');
      const credential = await prisma.biometricCredential.findFirstOrThrow({
        where: { employeeId: worker.id, kind: 'TERMINAL_FINGER' },
      });
      expect(credential.status).toBe('ACTIVE');
      // This server never sees a terminal's template, so it cannot compare one.
      expect(credential.dedupe).toBe('NOT_CHECKED');
      expect(credential.templateSealed).toBeNull();
      expect(credential.enrolledByUserId).toBe(company.adminUserId);

      // One window, one finger: a second is refused.
      const again = await report(terminal, [
        {
          deviceUserRef: worker.staffNumber,
          enrolledAt: new Date(Date.now() + 1000).toISOString(),
        },
      ]).expect(200);
      expect(again.body.results[0].status).toBe('REFUSED');
    });

    it('refuses a finger nobody asked for, and says so on the dashboard', async () => {
      const terminal = await registerTerminal('Unasked terminal');
      const worker = await newWorker();
      const enrolledAt = new Date().toISOString();

      const refused = await report(terminal, [
        { deviceUserRef: worker.staffNumber, enrolledAt },
      ]).expect(200);

      expect(refused.body.results[0].status).toBe('REFUSED');
      expect(
        await prisma.biometricCredential.count({
          where: { employeeId: worker.id, kind: 'TERMINAL_FINGER' },
        }),
      ).toBe(0);
      // Written down, and raised where an ADMIN will see it.
      const raised = await prisma.attendanceException.findFirst({
        where: { type: 'UNEXPECTED_DEVICE_ENROLLMENT', employeeId: worker.id },
      });
      expect(raised).not.toBeNull();
      const written = await prisma.terminalEnrollmentReport.findFirstOrThrow({
        where: { deviceId: terminal.id, deviceUserRef: worker.staffNumber },
      });
      expect(written.accepted).toBe(false);
      expect(written.credentialId).toBeNull();
    });

    it('writes down a user number that matches nobody, without naming anybody', async () => {
      const terminal = await registerTerminal('Unknown user terminal');

      const refused = await report(terminal, [
        { deviceUserRef: 'SMT-99999', enrolledAt: new Date().toISOString() },
      ]).expect(200);

      expect(refused.body.results[0].status).toBe('REFUSED');
      const written = await prisma.terminalEnrollmentReport.findFirstOrThrow({
        where: { deviceId: terminal.id, deviceUserRef: 'SMT-99999' },
      });
      expect(written.employeeId).toBeNull();
      expect(written.accepted).toBe(false);
    });

    it('makes one finger from one window, even from two reports at once', async () => {
      const terminal = await registerTerminal('Racing terminal');
      const worker = await newWorker();
      await openWindow(terminal, worker.id).expect(201);

      // Two reports the unique key cannot separate — same worker, same open
      // window, different moments — sent together. Asking "is it open?" and
      // writing "it is closed now" as two steps would let both through.
      const both = await Promise.all([
        report(terminal, [
          { deviceUserRef: worker.staffNumber, enrolledAt: new Date().toISOString() },
        ]).then((answer) => answer),
        report(terminal, [
          {
            deviceUserRef: worker.staffNumber,
            enrolledAt: new Date(Date.now() + 2000).toISOString(),
          },
        ]).then((answer) => answer),
      ]);

      const outcomes = both.map((answer) => answer.body.results[0].status).sort();
      expect(outcomes).toEqual(['ACCEPTED', 'REFUSED']);
      expect(
        await prisma.biometricCredential.count({
          where: { employeeId: worker.id, kind: 'TERMINAL_FINGER' },
        }),
      ).toBe(1);
    });

    it('answers DUPLICATE when the gateway resends a batch', async () => {
      const terminal = await registerTerminal('Resending terminal');
      const worker = await newWorker();
      await openWindow(terminal, worker.id).expect(201);
      const enrolledAt = new Date().toISOString();
      const batch = [{ deviceUserRef: worker.staffNumber, enrolledAt }];

      const first = await report(terminal, batch).expect(200);
      const second = await report(terminal, batch).expect(200);

      expect(first.body.results[0].status).toBe('ACCEPTED');
      // Nothing new happened, and nothing new was written.
      expect(second.body.results[0].status).toBe('DUPLICATE');
      expect(
        await prisma.biometricCredential.count({
          where: { employeeId: worker.id, kind: 'TERMINAL_FINGER' },
        }),
      ).toBe(1);
    });

    it('will not let a terminal wind its clock back into a closed window', async () => {
      const terminal = await registerTerminal('Wound back terminal');
      const worker = await newWorker();
      const open = await openWindow(terminal, worker.id).expect(201);
      // The ADMIN's window closes.
      await prisma.fingerEnrollmentWindow.update({
        where: { id: open.body.id },
        data: { expiresAt: new Date(Date.parse(open.body.opensAt) + 1) },
      });

      // The terminal claims it enrolled while the window was still open.
      const refused = await report(terminal, [
        { deviceUserRef: worker.staffNumber, enrolledAt: open.body.opensAt },
      ]).expect(200);

      expect(refused.body.results[0].status).toBe('REFUSED');
    });
  });
});
