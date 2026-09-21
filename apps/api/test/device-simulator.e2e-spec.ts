import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoDeviceSecret } from '../scripts/demo-devices.js';
import {
  planPunches,
  SHIFTS,
  type SimulatedDevice,
  sendHeartbeat,
  sendPunches,
} from '../scripts/device-simulator.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  registerDevice,
  tokensFor,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The Phase 2 demo's simulator: what it plans, and that the real API accepts
 * it over real HTTP, exactly as it would from a terminal.
 */
const now = new Date('2026-09-22T12:00:00Z');

describe('planPunches', () => {
  const dayGuard = { deviceUserRef: '1', ...SHIFTS.day };
  const guards = [dayGuard, { deviceUserRef: '2', ...SHIFTS['night-watch'] }];

  it('plays the same story on every run', () => {
    expect(planPunches({ guards, days: 30, now })).toEqual(planPunches({ guards, days: 30, now }));
  });

  it('never plans a punch in the future, and uses each event ID once', () => {
    const punches = planPunches({ guards, days: 30, now });
    expect(punches.every((punch) => Date.parse(punch.deviceTime) <= now.getTime())).toBe(true);
    expect(new Set(punches.map((punch) => punch.deviceEventId)).size).toBe(punches.length);
  });

  it('follows the shift pattern: night-watch clock-ins happen around 22:00', () => {
    const nightIns = planPunches({ guards, days: 30, now }).filter(
      (punch) => punch.deviceUserRef === '2' && punch.deviceEventId.endsWith('-in'),
    );
    expect(nightIns.length).toBeGreaterThan(20);
    expect(nightIns.every((punch) => ['21', '22'].includes(punch.deviceTime.slice(11, 13)))).toBe(
      true,
    );
  });

  it('shows a fast terminal clock in the punch times', () => {
    const [plain] = planPunches({ guards: [dayGuard], days: 1, now });
    const [fast] = planPunches({ guards: [dayGuard], days: 1, now, clockDriftSeconds: 420 });
    expect(Date.parse(fast?.deviceTime ?? '') - Date.parse(plain?.deviceTime ?? '')).toBe(420_000);
  });

  it('derives the same demo secret for the same name, and a different one per device', () => {
    expect(demoDeviceSecret('a'.repeat(32), 'ACC-01 Main Gate')).toBe(
      demoDeviceSecret('a'.repeat(32), 'ACC-01 Main Gate'),
    );
    expect(demoDeviceSecret('a'.repeat(32), 'ACC-01 Main Gate')).not.toBe(
      demoDeviceSecret('a'.repeat(32), 'ACC-02 Main Gate'),
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('the simulator against the real API (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let company: AttendanceCompany;
  let device: SimulatedDevice;

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    const tokens = await tokensFor(app, company);
    const registered = await registerDevice(app, tokens.admin, company.siteA, 'Simulated gate');
    device = { apiUrl: `${await app.getUrl()}/api/v1`, ...registered };
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('replays 10 days: stored once, paired into shifts, and a second replay changes nothing', async () => {
    const punches = planPunches({
      guards: [
        { deviceUserRef: '70001', ...SHIFTS.day },
        { deviceUserRef: '70004', ...SHIFTS['night-watch'] },
      ],
      days: 10,
      now: new Date(),
    });
    const first = await sendPunches(device, punches);
    expect(first).toEqual({ accepted: punches.length, duplicates: 0, conflicts: 0 });
    await sendHeartbeat(device);

    const nightShifts = await prisma.workSegment.findMany({
      where: { employeeId: company.supervisorEmployeeId, status: 'CONFIRMED' },
    });
    expect(nightShifts.length).toBeGreaterThan(5);
    // 22:00 to 06:00, give or take the simulator's few minutes of jitter.
    expect(nightShifts.every((shift) => Math.abs(shift.workedMinutes - 480) <= 22)).toBe(true);

    const again = await sendPunches(device, punches);
    expect(again).toEqual({ accepted: 0, duplicates: punches.length, conflicts: 0 });
  }, 60_000);
});
