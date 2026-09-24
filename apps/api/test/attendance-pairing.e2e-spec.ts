import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PairingService } from '../src/modules/attendance/pairing.service.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  registerDevice,
  signedPost,
  type TestDevice,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * Pairing punches into work segments, on a real PostgreSQL database: the
 * night shift, late punches, overlaps, the heartbeat's overdue check and a
 * person's void. Runs when TEST_DATABASE_URL points at a migrated database.
 * Times are relative to today, so the punches are never "in the future".
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

/** Midnight UTC (= Accra) `daysAgo` days ago, plus `hours`, as an ISO string. */
function at(daysAgo: number, hours: number): string {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - daysAgo * 86_400_000 + hours * 3_600_000).toISOString();
}

describe.skipIf(!databaseUrl)('Phase 2 pairing on a real database (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let company: AttendanceCompany;
  let gateA: TestDevice;
  let gateB: TestDevice;
  let events = 0;

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    const adminToken = await app.get(TokensService).signAccessToken({
      userId: company.adminUserId,
      companyId: company.companyId,
      role: 'ADMIN',
      onKiosk: false,
      employeeId: null,
    });
    gateA = await registerDevice(app, company, company.siteA, 'Gate A');
    gateB = await registerDevice(app, company, company.siteB, 'Gate B');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const punch = (
    deviceUserRef: string,
    deviceTime: string,
    direction: 'IN' | 'OUT' | 'UNKNOWN',
  ) => {
    events += 1;
    return {
      deviceEventId: `pair-${events}`,
      deviceUserRef,
      deviceTime,
      direction,
      method: 'FINGERPRINT',
    };
  };
  const send = (device: TestDevice, ...punches: ReturnType<typeof punch>[]) =>
    signedPost(app, 'ingest/punches', { punches }, device).expect(200);

  const segmentsOf = (employeeId: string, from: string, to: string) =>
    prisma.workSegment.findMany({
      where: { employeeId, startedAt: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { startedAt: 'asc' },
    });

  it('turns a 22:00-06:00 night shift into one 480-minute segment on the start date', async () => {
    await send(gateA, punch('70001', at(10, 22), 'IN'), punch('70001', at(9, 6), 'OUT'));
    const [segment, ...rest] = await segmentsOf(company.active.id, at(11, 0), at(9, 12));
    expect(rest).toEqual([]);
    expect(segment).toMatchObject({ workedMinutes: 480, status: 'CONFIRMED', basis: 'BIOMETRIC' });
    expect(segment?.workDate.toISOString().slice(0, 10)).toBe(at(10, 0).slice(0, 10));
  });

  it('pairs a clock-out that arrived before its clock-in, and closes the queue item', async () => {
    await send(gateA, punch('70001', at(8, 18), 'OUT'));
    const waiting = await prisma.attendanceException.findFirstOrThrow({
      where: { employeeId: company.active.id, type: 'MISSING_CLOCK_IN' },
    });
    expect(waiting.status).toBe('OPEN');

    await send(gateA, punch('70001', at(8, 6), 'IN'));
    const [segment] = await segmentsOf(company.active.id, at(8, 0), at(8, 23));
    expect(segment).toMatchObject({ workedMinutes: 720, status: 'CONFIRMED' });
    const closed = await prisma.attendanceException.findUniqueOrThrow({
      where: { id: waiting.id },
    });
    expect(closed.status).toBe('AUTO_CLOSED');
  });

  it('flags one person on shift at two sites at once: both disputed, one overlap exception', async () => {
    await send(gateA, punch('70001', at(6, 6), 'IN'), punch('70001', at(6, 18), 'OUT'));
    const atSiteB = [punch('70001', at(6, 10), 'IN'), punch('70001', at(6, 12), 'OUT')];
    await send(gateB, ...atSiteB);

    const segments = await segmentsOf(company.active.id, at(6, 0), at(6, 23));
    expect(segments.map((segment) => segment.status)).toEqual(['DISPUTED', 'DISPUTED']);
    const overlap = await prisma.attendanceException.findFirstOrThrow({
      where: { employeeId: company.active.id, type: 'OVERLAP' },
    });
    expect(overlap).toMatchObject({
      status: 'OPEN',
      siteId: company.siteA,
      secondSiteId: company.siteB,
      segmentId: segments[0]?.id,
      secondSegmentId: segments[1]?.id,
    });

    // Resending the same punches changes nothing.
    const before = await prisma.attendanceException.count({
      where: { companyId: company.companyId },
    });
    await send(gateB, ...atSiteB);
    expect(
      await prisma.attendanceException.count({ where: { companyId: company.companyId } }),
    ).toBe(before);
  });

  it('never brings back a shift a person voided', async () => {
    const [nightShift] = await segmentsOf(company.active.id, at(11, 0), at(9, 12));
    await prisma.workSegment.update({
      where: { id: nightShift?.id },
      data: { status: 'VOIDED', voidedAt: new Date(), voidedByUserId: company.adminUserId },
    });

    // Any new punch re-pairs this person's last 62 days.
    await send(gateA, punch('70001', at(4, 6), 'IN'), punch('70001', at(4, 14), 'OUT'));
    const [still] = await segmentsOf(company.active.id, at(11, 0), at(9, 12));
    expect(still).toMatchObject({ id: nightShift?.id, status: 'VOIDED' });
  });

  it('pairs a handover at the same second into two touching, counted shifts', async () => {
    await send(
      gateA,
      punch('70004', at(12, 6), 'IN'),
      punch('70004', at(12, 18), 'OUT'),
      punch('70004', at(12, 18), 'IN'),
      punch('70004', at(11, 6), 'OUT'),
    );
    const segments = await segmentsOf(company.supervisorEmployeeId, at(12, 0), at(11, 12));
    expect(segments.map((segment) => [segment.status, segment.workedMinutes])).toEqual([
      ['CONFIRMED', 720],
      ['CONFIRMED', 720],
    ]);
  });

  it('stores a punch that arrives more than 62 days late, but never pairs it', async () => {
    await send(gateA, punch('70004', at(70, 6), 'IN'), punch('70004', at(70, 18), 'OUT'));
    const old = await segmentsOf(company.supervisorEmployeeId, at(71, 0), at(69, 0));
    expect(old).toEqual([]);
    const stored = await prisma.punchEvent.count({
      where: { employeeId: company.supervisorEmployeeId, deviceTime: { lt: new Date(at(69, 0)) } },
    });
    expect(stored).toBe(2);
    const queued = await prisma.attendanceException.count({
      where: { employeeId: company.supervisorEmployeeId, occurredAt: { lt: new Date(at(69, 0)) } },
    });
    expect(queued).toBe(0);
  });

  it('leaves alone a shift that began before the 62-day window, even with a newer clock-out', async () => {
    const day = 86_400_000;
    const hour = 3_600_000;
    const edge = Date.now() - 62 * day;
    const clockIn = punch('70004', new Date(edge - 2 * hour).toISOString(), 'IN');
    const clockOut = punch('70004', new Date(edge + 6 * hour).toISOString(), 'OUT');
    await send(gateA, clockIn, clockOut);
    const segments = await prisma.workSegment.count({
      where: {
        employeeId: company.supervisorEmployeeId,
        startedAt: { gte: new Date(edge - 3 * hour), lt: new Date(edge + 7 * hour) },
      },
    });
    expect(segments).toBe(0);
    // And the newer clock-out is not reported as missing its clock-in.
    const out = await prisma.punchEvent.findFirstOrThrow({
      where: { deviceId: gateA.id, deviceEventId: clockOut.deviceEventId },
    });
    expect(await prisma.attendanceException.count({ where: { punchId: out.id } })).toBe(0);
  });

  it('a heartbeat notices a clock-in that has waited more than 16 hours', async () => {
    // Stored directly, as if it had arrived while it was still a shift in progress.
    const lonely = await prisma.punchEvent.create({
      data: {
        companyId: company.companyId,
        deviceId: gateA.id,
        siteId: company.siteA,
        deviceEventId: 'lonely-in',
        deviceUserRef: '70004',
        employeeId: company.supervisorEmployeeId,
        deviceTime: new Date(Date.now() - 20 * 3_600_000),
        serverTime: new Date(Date.now() - 20 * 3_600_000),
        direction: 'IN',
        method: 'FINGERPRINT',
        payloadHash: '0'.repeat(64),
      },
    });
    await signedPost(app, 'ingest/heartbeat', {}, gateA).expect(200);
    const raised = await prisma.attendanceException.findFirst({
      where: { punchId: lonely.id, type: 'MISSING_CLOCK_OUT' },
    });
    expect(raised?.status).toBe('OPEN');

    // The company's bookmark moved forward, so the next heartbeat does not look again.
    const bookmark = await prisma.attendanceCheck.findUniqueOrThrow({
      where: { companyId: company.companyId },
    });
    expect(bookmark.overdueCheckedUntil.getTime()).toBeGreaterThan(Date.now() - 17 * 3_600_000);
  });

  it('a heartbeat notices an UNKNOWN-direction clock-in left open too', async () => {
    const lonely = await prisma.punchEvent.create({
      data: {
        companyId: company.companyId,
        deviceId: gateB.id,
        siteId: company.siteB,
        deviceEventId: 'lonely-unknown',
        deviceUserRef: '70004',
        employeeId: company.supervisorEmployeeId,
        // 3 seconds short of 16 hours: still a shift in progress, and after the bookmark.
        deviceTime: new Date(Date.now() - 16 * 3_600_000 + 3_000),
        serverTime: new Date(Date.now() - 16 * 3_600_000 + 3_000),
        direction: 'UNKNOWN',
        method: 'FINGERPRINT',
        payloadHash: '1'.repeat(64),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 6_000)); // Let it turn 16 hours old.
    await signedPost(app, 'ingest/heartbeat', {}, gateB).expect(200);
    const raised = await prisma.attendanceException.findFirst({
      where: { punchId: lonely.id, type: 'MISSING_CLOCK_OUT' },
    });
    expect(raised?.status).toBe('OPEN');
  }, 20_000);

  it('re-pairs a limited number of people per check, and the next check carries on', async () => {
    // A fresh company, so its bookmark starts from nothing.
    const other = await createAttendanceCompany(prisma);
    const device = await prisma.device.create({
      data: {
        companyId: other.companyId,
        siteId: other.siteA,
        name: 'Direct gate',
        kind: 'MOCK',
        secretEncrypted: 'not-used-in-this-test',
      },
    });
    const lonelyIn = (employeeId: string, hoursAgo: number, ref: string) =>
      prisma.punchEvent.create({
        data: {
          companyId: other.companyId,
          deviceId: device.id,
          siteId: other.siteA,
          deviceEventId: `cap-${ref}`,
          deviceUserRef: ref,
          employeeId,
          deviceTime: new Date(Date.now() - hoursAgo * 3_600_000),
          serverTime: new Date(Date.now() - hoursAgo * 3_600_000),
          direction: 'IN',
          method: 'FINGERPRINT',
          payloadHash: '2'.repeat(64),
        },
      });
    const first = await lonelyIn(other.active.id, 20, '70001');
    const second = await lonelyIn(other.supervisorEmployeeId, 19, '70004');
    const raisedFor = (punchId: string) =>
      prisma.attendanceException.count({ where: { punchId, type: 'MISSING_CLOCK_OUT' } });

    const pairing = app.get(PairingService);
    await pairing.repairOverdueClockIns(other.companyId, new Date(), 1);
    expect([await raisedFor(first.id), await raisedFor(second.id)]).toEqual([1, 0]);
    const bookmark = await prisma.attendanceCheck.findUniqueOrThrow({
      where: { companyId: other.companyId },
    });
    // It stopped exactly where the second person's first punch is.
    expect(bookmark.overdueCheckedUntil.getTime()).toBe(second.deviceTime.getTime());

    await pairing.repairOverdueClockIns(other.companyId, new Date(), 1);
    expect(await raisedFor(second.id)).toBe(1);
  });
});
