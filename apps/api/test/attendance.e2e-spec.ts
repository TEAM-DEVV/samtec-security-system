import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { type SignedRoute, signRequest } from '../src/modules/attendance/device-signature.js';
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
 * Phase 2 attendance on a real PostgreSQL database: the device registry,
 * signed ingest, and the database rules behind punches and segments. Runs
 * when TEST_DATABASE_URL points at a migrated database (see db.e2e-spec.ts).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Phase 2 attendance on a real database (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let company: AttendanceCompany;
  let adminToken = '';
  let supervisorToken = '';
  /** A registered device and its one-time secret, shared by the ingest tests. */
  const gate = { id: '', secret: '' };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
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
      onKiosk: false,
      employeeId: company.supervisorEmployeeId,
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

  const signed = (
    route: SignedRoute,
    body: unknown,
    device: TestDevice = gate,
    timestamp?: string,
  ) => signedPost(app, route, body, device, timestamp);

  const punch = (overrides: Record<string, unknown> = {}) => ({
    deviceEventId: `e-${Math.random().toString(36).slice(2)}`,
    deviceUserRef: '70001',
    deviceTime: '2026-09-21T06:01:00Z',
    direction: 'IN',
    method: 'FINGERPRINT',
    ...overrides,
  });

  describe('the device registry', () => {
    it('registers a device and shows its secret exactly once', async () => {
      const registered = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Main gate', siteId: company.siteA, kind: 'ZKTECO' })
        .expect(201);
      await activateDevice(app, company, registered.body.device.id);

      expect(registered.headers['cache-control']).toBe('no-store');
      expect(registered.headers.location).toBe(`/api/v1/devices/${registered.body.device.id}`);
      expect(registered.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      gate.id = registered.body.device.id;
      gate.secret = registered.body.secret;

      // Never again: not in the read, not in the list, and not in the database as plain text.
      const read = await request(app.getHttpServer())
        .get(`/api/v1/devices/${gate.id}`)
        .set(...bearer(adminToken))
        .expect(200);
      expect(JSON.stringify(read.body)).not.toContain(gate.secret);
      const row = await prisma.device.findUniqueOrThrow({ where: { id: gate.id } });
      expect(row.secretEncrypted).not.toContain(gate.secret);

      await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Main gate', siteId: company.siteB, kind: 'MOCK' })
        .expect(409);
    });

    it('is for administrators only', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/devices')
        .set(...bearer(supervisorToken))
        .expect(403);
      await request(app.getHttpServer()).get('/api/v1/devices').expect(401);
    });

    it('refuses a site from outside the company', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Nowhere', siteId: '01927c3e-0000-7000-8000-00000000dead', kind: 'MOCK' })
        .expect(400);
      expect(response.body.errors[0].path).toBe('siteId');
    });

    const register = async (name: string, kind: 'MOCK' | 'ZKTECO' | 'FACE_KIOSK') => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name, siteId: company.siteA, kind })
        .expect(201);
      await activateDevice(app, company, response.body.device.id);
      return { id: response.body.device.id as string, secret: response.body.secret as string };
    };
    const patch = (deviceId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch(`/api/v1/devices/${deviceId}`)
        .set(...bearer(adminToken))
        .send(body);

    it('gives a ZKTeco terminal a serial number, unique in the company', async () => {
      const first = await register('Serial gate one', 'ZKTECO');
      const second = await register('Serial gate two', 'ZKTECO');
      const simulator = await register('Serial simulator', 'MOCK');

      const set = await patch(first.id, { serialNumber: 'CKJ-1234567' }).expect(200);
      expect(set.body.serialNumber).toBe('CKJ-1234567');
      await patch(second.id, { serialNumber: 'CKJ-1234567' }).expect(409);
      const wrongKind = await patch(simulator.id, { serialNumber: 'CKJ-7654321' }).expect(400);
      expect(wrongKind.body.errors[0].path).toBe('serialNumber');
      const badCharacters = await patch(first.id, { serialNumber: 'CKJ 12/34' }).expect(400);
      expect(badCharacters.body.errors[0].path).toBe('serialNumber');

      const cleared = await patch(first.id, { serialNumber: null }).expect(200);
      expect(cleared.body.serialNumber).toBeNull();
      // Once cleared, the serial is free for the other terminal.
      await patch(second.id, { serialNumber: 'CKJ-1234567' }).expect(200);
    });

    it('switches fingerprints on only for a kiosk, and switching them off revokes its keys', async () => {
      const kiosk = await register('Front desk kiosk', 'FACE_KIOSK');
      const terminal = await register('Fingerprint terminal', 'ZKTECO');

      const on = await patch(kiosk.id, { passkeysEnabled: true }).expect(200);
      expect(on.body.passkeysEnabled).toBe(true);
      const wrongKind = await patch(terminal.id, { passkeysEnabled: true }).expect(400);
      expect(wrongKind.body.errors[0].path).toBe('passkeysEnabled');

      // A worker's key saved on the kiosk (PR 7 registers them; here, directly).
      const key = await prisma.devicePasskey.create({
        data: {
          companyId: company.companyId,
          employeeId: company.active.id,
          deviceId: kiosk.id,
          credentialId: `test-key-${kiosk.id}`,
          publicKey: new Uint8Array([1, 2, 3]),
          backedUp: false,
          registeredByUserId: company.adminUserId,
        },
      });

      const off = await patch(kiosk.id, { passkeysEnabled: false }).expect(200);
      expect(off.body.passkeysEnabled).toBe(false);
      const revoked = await prisma.devicePasskey.findUniqueOrThrow({ where: { id: key.id } });
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked.revokedByUserId).toBe(company.adminUserId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: kiosk.id, action: 'device.updated' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.detail).toMatchObject({ changedFields: 'passkeysEnabled', revokedPasskeys: 1 });
    });
  });

  describe('signed ingest', () => {
    it('stores a batch sent twice at the same moment exactly once', async () => {
      const batch = {
        punches: [punch({ deviceEventId: 'race-1', deviceTime: '2026-09-15T06:00:00Z' })],
      };
      const [first, second] = await Promise.all([
        signed('ingest/punches', batch),
        signed('ingest/punches', batch),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect([first.body.results[0].status, second.body.results[0].status].sort()).toEqual([
        'ACCEPTED',
        'DUPLICATE',
      ]);
      const rows = await prisma.punchEvent.count({
        where: { deviceId: gate.id, deviceEventId: 'race-1' },
      });
      expect(rows).toBe(1);
    });

    it('answers 503 with Retry-After while another batch holds the company lock', async () => {
      const lockKey = `attendance:${company.companyId}`;
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
          await new Promise((resolve) => setTimeout(resolve, 12_000));
        },
        { timeout: 20_000 },
      );
      // Let the holder take the lock first.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const busy = await signed('ingest/punches', {
        punches: [punch({ deviceEventId: 'busy-1' })],
      });
      await holder;
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
      // Nothing was kept: the device's resend is what stores it.
      const rows = await prisma.punchEvent.count({
        where: { deviceId: gate.id, deviceEventId: 'busy-1' },
      });
      expect(rows).toBe(0);
    }, 30_000);

    it('stores new punches, and a resend changes nothing', async () => {
      const batch = {
        punches: [
          punch({ deviceEventId: 'batch-1' }),
          punch({ deviceEventId: 'batch-2', direction: 'OUT', deviceTime: '2026-09-21T18:03:00Z' }),
        ],
      };

      const first = await signed('ingest/punches', batch).expect(200);
      expect(first.body).toMatchObject({ accepted: 2, duplicates: 0, conflicts: 0 });

      const again = await signed('ingest/punches', batch).expect(200);
      expect(again.body).toMatchObject({ accepted: 0, duplicates: 2, conflicts: 0 });
      expect(again.body.results[0].punchId).toBe(first.body.results[0].punchId);

      const stored = await prisma.punchEvent.findMany({
        where: { deviceId: gate.id, deviceEventId: { in: ['batch-1', 'batch-2'] } },
      });
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.employeeId === company.active.id)).toBe(true);
    });

    it('keeps out a changed resend (CONFLICT) and audits it', async () => {
      await signed('ingest/punches', { punches: [punch({ deviceEventId: 'tamper-1' })] }).expect(
        200,
      );
      const changed = await signed('ingest/punches', {
        punches: [punch({ deviceEventId: 'tamper-1', deviceTime: '2026-09-21T05:01:00Z' })],
      }).expect(200);
      expect(changed.body.results[0].status).toBe('CONFLICT');

      const audits = await prisma.auditLog.findMany({
        where: { action: 'attendance.punch_conflict', entityId: changed.body.results[0].punchId },
      });
      expect(audits).toHaveLength(1);
    });

    it('queues unknown numbers once per device, number and day', async () => {
      await signed('ingest/punches', {
        punches: [
          punch({ deviceUserRef: '99001', deviceTime: '2026-09-20T06:00:00Z' }),
          punch({ deviceUserRef: '99001', deviceTime: '2026-09-20T18:00:00Z', direction: 'OUT' }),
        ],
      }).expect(200);
      const exceptions = await prisma.attendanceException.findMany({
        where: { companyId: company.companyId, type: 'UNKNOWN_EMPLOYEE' },
      });
      expect(exceptions).toHaveLength(1);
      const unmatched = await prisma.punchEvent.findMany({
        where: { deviceId: gate.id, deviceUserRef: '99001' },
      });
      expect(unmatched.every((row) => row.employeeId === null)).toBe(true);
    });

    it('records punches from people who may not clock in, and queues them', async () => {
      await signed('ingest/punches', {
        punches: [
          punch({ deviceUserRef: '70002', deviceTime: '2026-09-19T06:00:00Z' }), // suspended
          punch({ deviceUserRef: '70003', deviceTime: '2026-09-10T06:00:00Z' }), // leaver, last day: fine
          punch({ deviceUserRef: '70003', deviceTime: '2026-09-12T06:00:00Z' }), // leaver, after: flagged
        ],
      }).expect(200);
      const flagged = await prisma.attendanceException.findMany({
        where: { companyId: company.companyId, type: 'INACTIVE_EMPLOYEE' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(flagged.map((row) => [row.employeeId, row.occurredAt.toISOString()])).toEqual([
        [company.leaver.id, '2026-09-12T06:00:00.000Z'],
        [company.suspended.id, '2026-09-19T06:00:00.000Z'],
      ]);
    });

    it('stores an impossible future time but will never pair it', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const response = await signed('ingest/punches', {
        punches: [punch({ deviceTime: future })],
      }).expect(200);
      const row = await prisma.punchEvent.findUniqueOrThrow({
        where: { id: response.body.results[0].punchId },
      });
      expect(row).toMatchObject({ pairable: false, clockSuspect: true });
    });

    it('measures clock drift from the heartbeat', async () => {
      const fast = new Date(Date.now() + 420_000).toISOString();
      const beat = await signed('ingest/heartbeat', { deviceClockAt: fast }).expect(200);
      expect(Date.parse(beat.body.serverTime)).toBeGreaterThan(0);
      const device = await prisma.device.findUniqueOrThrow({ where: { id: gate.id } });
      expect(device.lastClockDriftSeconds).toBeGreaterThanOrEqual(418);
      expect(device.lastSeenAt).not.toBeNull();
    });

    it('checks the batch: at most 100 punches, each event ID once', async () => {
      const many = Array.from({ length: 101 }, (_, index) =>
        punch({ deviceEventId: `many-${index}` }),
      );
      await signed('ingest/punches', { punches: many }).expect(400);
      await signed('ingest/punches', {
        punches: [punch({ deviceEventId: 'twice' }), punch({ deviceEventId: 'twice' })],
      }).expect(400);
      await signed('ingest/punches', { punches: [punch({ template: 'sneaky' })] }).expect(400);
    });

    it('refuses a body over 100 kB before reading it', async () => {
      const huge = {
        punches: [punch({ deviceEventId: 'x'.repeat(100), deviceUserRef: '1' })],
        padding: 'x'.repeat(110_000),
      };
      await signed('ingest/punches', huge).expect(413);
    });
  });

  describe('device trust', () => {
    it('answers every kind of failure with the same 401', async () => {
      const body = { punches: [punch()] };
      const answers = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/ingest/punches').send(body),
        signed('ingest/punches', body, { id: gate.id, secret: 'wrong-secret' }),
        signed('ingest/punches', body, gate, String(Math.floor(Date.now() / 1000) - 400)),
        signed('ingest/punches', body, { id: '01927c3e-0000-7000-8000-00000000dead', secret: 'x' }),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401]);
      expect(new Set(answers.map((answer) => answer.body.detail)).size).toBe(1);
    });

    it('never accepts a signature made for the other route, or a user token', async () => {
      const text = JSON.stringify({ punches: [punch()] });
      const timestamp = String(Math.floor(Date.now() / 1000));
      await request(app.getHttpServer())
        .post('/api/v1/ingest/punches')
        .set('Content-Type', 'application/json')
        .set('X-Samtec-Device', gate.id)
        .set('X-Samtec-Timestamp', timestamp)
        .set('X-Samtec-Signature', signRequest(gate.secret, timestamp, 'ingest/heartbeat', text))
        .send(text)
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/ingest/punches')
        .set(...bearer(adminToken))
        .send({ punches: [punch()] })
        .expect(401);
    });

    it('never takes punches from a kiosk, and says so like any other failure', async () => {
      const registered = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Kiosk at the gate', siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      await activateDevice(app, company, registered.body.device.id);
      const kiosk = { id: registered.body.device.id, secret: registered.body.secret };

      // A correct signature, but a kiosk's punches only ever come from a face match.
      const refused = await signed('ingest/punches', { punches: [punch()] }, kiosk).expect(401);
      const wrongSecret = await signed(
        'ingest/punches',
        { punches: [punch()] },
        {
          id: kiosk.id,
          secret: 'wrong',
        },
      ).expect(401);
      expect(refused.body.detail).toBe(wrongSecret.body.detail);
      expect(await prisma.punchEvent.count({ where: { deviceId: kiosk.id } })).toBe(0);

      // It may still say it is alive.
      await signed('ingest/heartbeat', {}, kiosk).expect(200);
    });

    it.each([
      ['in production, where the setting is left out', { NODE_ENV: 'production' as const }],
      ['wherever the setting says no', { ALLOW_SIMULATOR_DEVICES: 'no' as const }],
    ])('refuses simulator punches %s', async (where, settings) => {
      const registered = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: `Simulator ${where}`.slice(0, 60), siteId: company.siteA, kind: 'MOCK' })
        .expect(201);
      await activateDevice(app, company, registered.body.device.id);
      const simulator = { id: registered.body.device.id, secret: registered.body.secret };
      const refusing = await createDbTestApp(databaseUrl as string, settings);
      try {
        await signedPost(refusing, 'ingest/punches', { punches: [punch()] }, simulator).expect(401);
        // It may still say it is alive.
        await signedPost(refusing, 'ingest/heartbeat', {}, simulator).expect(200);
      } finally {
        await refusing.close();
      }
    });

    it('counts wrong signatures, but at most once a minute', async () => {
      // A fresh device, so the first wrong signature is sure to be counted.
      const fresh = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Targeted', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      await activateDevice(app, company, fresh.body.device.id);
      const deviceId = fresh.body.device.id;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await signed('ingest/heartbeat', {}, { id: deviceId, secret: 'still-wrong' }).expect(401);
      }
      const after = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(after.failedSignatureCount).toBe(1);
      expect(after.lastFailedSignatureAt).not.toBeNull();
    });

    it('a new key is born switched off, and its issuer may not switch it on', async () => {
      const made = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Two-person gate', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      // A device key can post punches, so one person never both issues one
      // and puts it to work (docs/plan/06, "Two administrators").
      expect(made.body.device.status).toBe('INACTIVE');
      const key = { id: made.body.device.id as string, secret: made.body.secret as string };
      await signed('ingest/heartbeat', {}, key).expect(401);

      const refused = await request(app.getHttpServer())
        .patch(`/api/v1/devices/${key.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'ACTIVE' })
        .expect(409);
      expect(refused.body.detail).toMatch(/another administrator/i);

      // The second administrator has seen the device on the wall.
      await activateDevice(app, company, key.id);
      await signed('ingest/heartbeat', {}, key).expect(200);
    });

    it('records who issued a key and who switched it on, and clears the second on the way off', async () => {
      const made = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Recorded gate', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      const deviceId = made.body.device.id as string;
      await activateDevice(app, company, deviceId);

      const on = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(on.keyIssuedByUserId).toBe(company.adminUserId);
      expect(on.activatedByUserId).toBe(company.secondAdminUserId);

      // Switching off is open to anybody: it only takes power away. It also
      // forgets who vouched, so going back on needs answering for again.
      await request(app.getHttpServer())
        .patch(`/api/v1/devices/${deviceId}`)
        .set(...bearer(adminToken))
        .send({ status: 'INACTIVE' })
        .expect(200);
      const off = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(off.activatedByUserId).toBeNull();
      expect(off.keyIssuedByUserId).toBe(company.adminUserId);
    });

    it('cannot be raced: rotating while switching on never leaves a live unapproved key', async () => {
      const made = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Raced gate', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      const deviceId = made.body.device.id as string;
      await activateDevice(app, company, deviceId);

      // The issuer rotates the key and switches it on in the same breath. The
      // rotate sets the device INACTIVE; without the row lock the switch-on
      // could read the older ACTIVE status, skip the two-person gate, and
      // leave a fresh key working that nobody approved.
      await Promise.allSettled([
        request(app.getHttpServer())
          .post(`/api/v1/devices/${deviceId}/rotate-secret`)
          .set(...bearer(adminToken)),
        request(app.getHttpServer())
          .patch(`/api/v1/devices/${deviceId}`)
          .set(...bearer(adminToken))
          .send({ status: 'ACTIVE' }),
      ]);

      const after = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      // Whichever order they landed in: a live device was switched on by
      // somebody, and never by the person who issued its key.
      if (after.status === 'ACTIVE') {
        expect(after.activatedAt).not.toBeNull();
        expect(after.activatedByUserId).not.toBe(after.keyIssuedByUserId);
      }
    });

    it('refuses in the database too: a key issuer can never be its activator', async () => {
      const made = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Database rule gate', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);

      // Straight past the service, as a repair script would go.
      await expect(
        prisma.device.update({
          where: { id: made.body.device.id },
          data: { status: 'ACTIVE', activatedByUserId: company.adminUserId },
        }),
      ).rejects.toThrow();
    });

    it('rotating the secret kills the old one at once', async () => {
      const rotated = await request(app.getHttpServer())
        .post(`/api/v1/devices/${gate.id}/rotate-secret`)
        .set(...bearer(adminToken))
        .expect(200);
      expect(rotated.headers['cache-control']).toBe('no-store');
      const old = { ...gate };
      gate.secret = rotated.body.secret;

      await signed('ingest/heartbeat', {}, old).expect(401);
      // And the new one does nothing yet: a rotated key is a new key, so the
      // device waits for a second administrator to switch it back on
      // (docs/plan/06, 'Two administrators'). Rotating is how a stolen device
      // is dealt with; it must not be how one person gets a working key.
      expect(rotated.body.device.status).toBe('INACTIVE');
      await signed('ingest/heartbeat', {}).expect(401);

      await activateDevice(app, company, gate.id);
      await signed('ingest/heartbeat', {}).expect(200);
    });

    it('a switched-off device is refused', async () => {
      const spare = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Spare', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      await activateDevice(app, company, spare.body.device.id);
      const device = { id: spare.body.device.id, secret: spare.body.secret };
      await signed('ingest/heartbeat', {}, device).expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/devices/${device.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'INACTIVE' })
        .expect(200);
      await signed('ingest/heartbeat', {}, device).expect(401);
    });

    it('limits each device to 60 signed requests a minute', async () => {
      const spare = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Chatty', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
      await activateDevice(app, company, spare.body.device.id);
      const device = { id: spare.body.device.id, secret: spare.body.secret };
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 61; attempt += 1) {
        statuses.push((await signed('ingest/heartbeat', {}, device)).status);
      }
      expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
      const limited = await signed('ingest/heartbeat', {}, device).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('database rules', () => {
    it('punches can never be changed, deleted or truncated', async () => {
      const row = await prisma.punchEvent.findFirstOrThrow({ where: { deviceId: gate.id } });
      await expect(
        prisma.punchEvent.update({ where: { id: row.id }, data: { deviceUserRef: 'x' } }),
      ).rejects.toThrow();
      await expect(prisma.punchEvent.delete({ where: { id: row.id } })).rejects.toThrow();
      await expect(prisma.$executeRawUnsafe('TRUNCATE punch_events CASCADE')).rejects.toThrow();
    });

    it('two counted shifts of one person can never overlap; touching ones can', async () => {
      const shift = (
        startedAt: string,
        endedAt: string,
        status: 'CONFIRMED' | 'DISPUTED' = 'CONFIRMED',
      ) => ({
        companyId: company.companyId,
        employeeId: company.active.id,
        siteId: company.siteA,
        workDate: new Date(`${startedAt.slice(0, 10)}T00:00:00Z`),
        startedAt: new Date(startedAt),
        endedAt: new Date(endedAt),
        workedMinutes: (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000,
        basis: 'MANUAL' as const,
        status,
      });

      // 06:00-18:00 then 18:00-06:00: they touch, so both count.
      await prisma.workSegment.createMany({
        data: [
          shift('2026-08-01T06:00:00Z', '2026-08-01T18:00:00Z'),
          shift('2026-08-01T18:00:00Z', '2026-08-02T06:00:00Z'),
        ],
      });
      // A disputed overlap is allowed: it is evidence, not counted time.
      await prisma.workSegment.create({
        data: shift('2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z', 'DISPUTED'),
      });
      // A counted overlap is refused when the transaction commits.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.workSegment.create({
            data: shift('2026-08-01T11:00:00Z', '2026-08-01T13:00:00Z'),
          });
        }),
      ).rejects.toThrow(/work_segments_no_overlap|23P01|exclusion/i);
    });

    it('refuses a shift longer than 16 hours, and one with the wrong minutes', async () => {
      const manual = (endedAt: string, workedMinutes: number) =>
        prisma.workSegment.create({
          data: {
            companyId: company.companyId,
            employeeId: company.active.id,
            siteId: company.siteA,
            workDate: new Date('2026-08-05T00:00:00Z'),
            startedAt: new Date('2026-08-05T00:00:00Z'),
            endedAt: new Date(endedAt),
            workedMinutes,
            basis: 'MANUAL',
          },
        });
      await expect(manual('2026-08-05T17:00:00Z', 1020)).rejects.toThrow(
        /work_segments_times_valid/,
      );
      await expect(manual('2026-08-05T08:00:00Z', 999)).rejects.toThrow(
        /work_segments_times_valid/,
      );
    });
  });
});
