import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { type SignedRoute, signRequest } from '../src/modules/attendance/device-signature.js';
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
    });
    supervisorToken = await tokens.signAccessToken({
      userId: company.supervisorUserId,
      companyId: company.companyId,
      role: 'SUPERVISOR',
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
  });

  describe('signed ingest', () => {
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

    it('counts wrong signatures at most once a minute', async () => {
      const before = await prisma.device.findUniqueOrThrow({ where: { id: gate.id } });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await signed('ingest/heartbeat', {}, { id: gate.id, secret: 'still-wrong' }).expect(401);
      }
      const after = await prisma.device.findUniqueOrThrow({ where: { id: gate.id } });
      expect(after.failedSignatureCount - before.failedSignatureCount).toBeLessThanOrEqual(1);
      expect(after.lastFailedSignatureAt).not.toBeNull();
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
      await signed('ingest/heartbeat', {}).expect(200);
    });

    it('a switched-off device is refused', async () => {
      const spare = await request(app.getHttpServer())
        .post('/api/v1/devices')
        .set(...bearer(adminToken))
        .send({ name: 'Spare', siteId: company.siteB, kind: 'MOCK' })
        .expect(201);
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

    it('refuses a shift longer than 16 hours or one with the wrong minutes', async () => {
      await expect(
        prisma.workSegment.create({
          data: {
            companyId: company.companyId,
            employeeId: company.active.id,
            siteId: company.siteA,
            workDate: new Date('2026-08-05T00:00:00Z'),
            startedAt: new Date('2026-08-05T00:00:00Z'),
            endedAt: new Date('2026-08-05T17:00:00Z'),
            workedMinutes: 1020,
            basis: 'MANUAL',
          },
        }),
      ).rejects.toThrow();
    });
  });
});
