import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  registerDevice,
  signedPost,
  type TestDevice,
  tokensFor,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * Reading work segments and the exception queue, and resolving exceptions,
 * on a real PostgreSQL database: who sees what, who may decide, and what each
 * decision changes. Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

/** Midnight UTC (= Accra) `daysAgo` days ago, plus `hours`, as an ISO string. */
function at(daysAgo: number, hours: number): string {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - daysAgo * 86_400_000 + hours * 3_600_000).toISOString();
}
const dateOf = (daysAgo: number) => at(daysAgo, 0).slice(0, 10);

describe.skipIf(!databaseUrl)('Phase 2 attendance queue on a real database (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let company: AttendanceCompany;
  let tokens: Awaited<ReturnType<typeof tokensFor>>;
  let gateA: TestDevice;
  let gateB: TestDevice;
  let events = 0;

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    tokens = await tokensFor(app, company);
    gateA = await registerDevice(app, company, company.siteA, 'Queue gate A');
    gateB = await registerDevice(app, company, company.siteB, 'Queue gate B');

    const punch = (ref: string, deviceTime: string, direction: 'IN' | 'OUT') => {
      events += 1;
      return {
        deviceEventId: `q-${events}`,
        deviceUserRef: ref,
        deviceTime,
        direction,
        method: 'FINGERPRINT',
      };
    };
    const send = (device: TestDevice, ...punches: ReturnType<typeof punch>[]) =>
      signedPost(app, 'ingest/punches', { punches }, device).expect(200);

    // Day 5: an ordinary day shift at A. Day 4: a shift at B.
    await send(gateA, punch('70001', at(5, 6), 'IN'), punch('70001', at(5, 18), 'OUT'));
    await send(gateB, punch('70001', at(4, 6), 'IN'), punch('70001', at(4, 18), 'OUT'));
    // Day 4, 20:00: a clock-out at A with no clock-in (the shift at B ran 06:00-18:00).
    await send(gateA, punch('70001', at(4, 20), 'OUT'));
    // Day 3: a clock-in at A with no clock-out, and an unknown number at A.
    await send(gateA, punch('70001', at(3, 6), 'IN'), punch('99001', at(3, 7), 'IN'));
    // Day 2: two shifts at once, at A and at B.
    await send(gateA, punch('70001', at(2, 6), 'IN'), punch('70001', at(2, 18), 'OUT'));
    await send(gateB, punch('70001', at(2, 10), 'IN'), punch('70001', at(2, 12), 'OUT'));
    // Day 1: the supervisor's own clock-in with no clock-out.
    await send(gateA, punch('70004', at(1, 6), 'IN'), punch('70004', at(1, 6), 'IN'));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const get = (token: string, path: string, query: Record<string, string | number> = {}) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .query(query);
  const resolve = (token: string, exceptionId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/attendance/exceptions/${exceptionId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const range = { from: dateOf(10), to: dateOf(0) };
  const exceptionOf = async (type: string, employeeId: string | null) =>
    prisma.attendanceException.findFirstOrThrow({
      where: { companyId: company.companyId, type: type as never, employeeId },
    });

  describe('work segments', () => {
    it('shows an administrator everyone, sorted by start, with names', async () => {
      const { body } = await get(tokens.admin, '/attendance/segments', range).expect(200);
      expect(body.items.length).toBeGreaterThanOrEqual(4);
      const starts = body.items.map((item: { startedAt: string }) => item.startedAt);
      expect([...starts].sort()).toEqual(starts);
      expect(body.items[0].employee).toMatchObject({ staffNumber: 'SMT-70001' });
    });

    it('pages with a cursor, never repeating a row', async () => {
      const first = await get(tokens.admin, '/attendance/segments', { ...range, limit: 1 }).expect(
        200,
      );
      expect(first.body.nextCursor).toBeTruthy();
      const second = await get(tokens.admin, '/attendance/segments', {
        ...range,
        limit: 1,
        cursor: first.body.nextCursor,
      }).expect(200);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
      await get(tokens.admin, '/attendance/segments', { ...range, cursor: 'nonsense!' }).expect(
        400,
      );
    });

    it('shows a supervisor only their own site, and 404s the other one', async () => {
      const { body } = await get(tokens.supervisor, '/attendance/segments', range).expect(200);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((item: { siteId: string }) => item.siteId === company.siteA)).toBe(
        true,
      );
      await get(tokens.supervisor, '/attendance/segments', {
        ...range,
        siteId: company.siteB,
      }).expect(404);
    });

    it('shows a guard only themselves, and 404s anyone or anything else', async () => {
      const { body } = await get(tokens.guard, '/attendance/segments', range).expect(200);
      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every(
          (item: { employee: { id: string } }) => item.employee.id === company.active.id,
        ),
      ).toBe(true);
      await get(tokens.guard, '/attendance/segments', {
        ...range,
        employeeId: company.supervisorEmployeeId,
      }).expect(404);
      await get(tokens.guard, '/attendance/segments', { ...range, siteId: company.siteA }).expect(
        404,
      );
    });

    it('refuses more than 31 days', async () => {
      const response = await get(tokens.admin, '/attendance/segments', {
        from: dateOf(40),
        to: dateOf(0),
      }).expect(400);
      expect(response.body.errors[0].path).toBe('to');
    });
  });

  describe('the exception queue', () => {
    it('lets HR read the queue but never resolve it', async () => {
      const { body } = await get(tokens.hr, '/attendance/exceptions').expect(200);
      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every((item: { allowedActions: string[] }) => item.allowedActions.length === 0),
      ).toBe(true);
      const unknown = await exceptionOf('UNKNOWN_EMPLOYEE', null);
      await resolve(tokens.hr, unknown.id, { action: 'DISMISS', note: 'Checked.' }).expect(403);
    });

    it('pages the queue newest first with a cursor, never repeating an item', async () => {
      const first = await get(tokens.admin, '/attendance/exceptions', { limit: 1 }).expect(200);
      expect(first.body.nextCursor).toBeTruthy();
      const second = await get(tokens.admin, '/attendance/exceptions', {
        limit: 1,
        cursor: first.body.nextCursor,
      }).expect(200);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
      expect(second.body.items[0].occurredAt <= first.body.items[0].occurredAt).toBe(true);
      await get(tokens.admin, '/attendance/exceptions', { cursor: 'nonsense!' }).expect(400);
    });

    it('refuses the queue to a guard', async () => {
      await get(tokens.guard, '/attendance/exceptions').expect(403);
    });

    it('hides an overlap reaching another site from a supervisor', async () => {
      const overlap = await exceptionOf('OVERLAP', company.active.id);
      const { body } = await get(tokens.supervisor, '/attendance/exceptions', {
        type: 'OVERLAP',
      }).expect(200);
      expect(body.items).toEqual([]);
      await get(tokens.supervisor, `/attendance/exceptions/${overlap.id}`).expect(404);
      await resolve(tokens.supervisor, overlap.id, {
        action: 'VOID_ALL',
        note: 'Not mine.',
      }).expect(404);
    });

    it('never lets anyone resolve their own attendance', async () => {
      const own = await exceptionOf('MISSING_CLOCK_OUT', company.supervisorEmployeeId);
      const { body } = await get(tokens.supervisor, `/attendance/exceptions/${own.id}`).expect(200);
      expect(body.allowedActions).toEqual([]);
      await resolve(tokens.supervisor, own.id, { action: 'DISMISS', note: 'Forgot.' }).expect(403);
    });

    it('lets a supervisor dismiss an unknown number at their site; the note stays out of the audit log', async () => {
      const unknown = await exceptionOf('UNKNOWN_EMPLOYEE', null);
      const { body } = await resolve(tokens.supervisor, unknown.id, {
        action: 'DISMISS',
        note: 'A visitor tried the reader.',
      }).expect(200);
      expect(body).toMatchObject({
        status: 'RESOLVED',
        resolution: { action: 'DISMISS', note: 'A visitor tried the reader.' },
        allowedActions: [],
      });
      expect(body.punch).toMatchObject({ deviceName: 'Queue gate A', deviceUserRef: '99001' });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'attendance.exception_resolved', entityId: unknown.id },
      });
      expect(JSON.stringify(audit.detail)).not.toContain('visitor');

      await resolve(tokens.supervisor, unknown.id, { action: 'DISMISS', note: 'Twice.' }).expect(
        409,
      );
    });

    it('adds a missing shift only around the real punch, and never over another shift', async () => {
      const missing = await exceptionOf('MISSING_CLOCK_OUT', company.active.id);
      const wrongAction = await resolve(tokens.supervisor, missing.id, {
        action: 'VOID_ALL',
        note: 'Wrong action.',
      }).expect(400);
      expect(wrongAction.body.errors[0].path).toBe('action');
      await resolve(tokens.supervisor, missing.id, {
        action: 'ADD_SEGMENT',
        startedAt: at(3, 7),
        endedAt: at(3, 17),
        note: 'The punch is not inside.',
      }).expect(400);
      await resolve(tokens.supervisor, missing.id, {
        action: 'ADD_SEGMENT',
        startedAt: at(3, 6),
        endedAt: at(3, 23),
        note: 'Seventeen hours is too long.',
      }).expect(400);

      const { body } = await resolve(tokens.supervisor, missing.id, {
        action: 'ADD_SEGMENT',
        startedAt: at(3, 6),
        endedAt: at(3, 18),
        note: 'The relief guard confirms he left at six.',
      }).expect(200);
      expect(body.status).toBe('RESOLVED');
      const manual = await prisma.workSegment.findUniqueOrThrow({
        where: { id: body.resolutionSegmentId },
      });
      expect(manual).toMatchObject({ basis: 'MANUAL', status: 'CONFIRMED', workedMinutes: 720 });

      // A clock-out at 20:00 whose hand-added hours would reach back over the 06:00-18:00 shift.
      const missingIn = await exceptionOf('MISSING_CLOCK_IN', company.active.id);
      const clash = await resolve(tokens.supervisor, missingIn.id, {
        action: 'ADD_SEGMENT',
        startedAt: at(4, 10),
        endedAt: at(4, 20),
        note: 'This would double-count the morning.',
      }).expect(409);
      expect(clash.body.detail).toContain('overlap');
      const unchanged = await prisma.attendanceException.findUniqueOrThrow({
        where: { id: missingIn.id },
      });
      expect(unchanged.status).toBe('OPEN');
    });

    it('keeps one side of an overlap; the other is voided for good', async () => {
      const overlap = await exceptionOf('OVERLAP', company.active.id);
      const keep = overlap.segmentId ?? '';
      const foreign = await resolve(tokens.admin, overlap.id, {
        action: 'KEEP_SEGMENT',
        segmentId: randomUUID(),
        note: 'Not one of the two.',
      }).expect(400);
      expect(foreign.body.errors[0].path).toBe('segmentId');

      const { body } = await resolve(tokens.admin, overlap.id, {
        action: 'KEEP_SEGMENT',
        segmentId: keep,
        note: 'The site log shows site A only.',
      }).expect(200);
      expect(
        body.segments.map((segment: { id: string; status: string }) => [
          segment.id,
          segment.status,
        ]),
      ).toEqual([
        [keep, 'CONFIRMED'],
        [overlap.secondSegmentId, 'VOIDED'],
      ]);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'attendance.exception_resolved', entityId: overlap.id },
      });
      expect(audit.detail).toMatchObject({
        keptSegmentId: keep,
        voidedSegmentIds: overlap.secondSegmentId,
      });

      // A later punch re-pairs the person, and the voided shift stays voided.
      events += 1;
      await signedPost(
        app,
        'ingest/punches',
        {
          punches: [
            {
              deviceEventId: `q-${events}`,
              deviceUserRef: '70001',
              deviceTime: at(1, 6),
              direction: 'IN',
              method: 'FINGERPRINT',
            },
          ],
        },
        gateA,
      ).expect(200);
      const voided = await prisma.workSegment.findUniqueOrThrow({
        where: { id: overlap.secondSegmentId ?? '' },
      });
      expect(voided).toMatchObject({ status: 'VOIDED', voidedByUserId: company.adminUserId });
    });
  });
});
