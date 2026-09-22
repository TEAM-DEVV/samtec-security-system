/**
 * The Phase 2 demo: pretend clock-in terminals replay the last 30 days of
 * punches through the real, signed ingest endpoint, and the dashboard's
 * attendance pages fill in. docs/guides/10-attendance-demo.md walks through it.
 *
 * On this computer (after `pnpm db:seed`, with the API running):
 *
 *   pnpm --filter @samtec/api mock:devices
 *
 * plays every seeded demo device, with each guard following the shift
 * pattern of their site posting. Running it twice changes nothing: every
 * punch comes back DUPLICATE.
 *
 * Against any other API (for example TEST), register a MOCK device on the
 * Devices page first, then pass what it showed you once:
 *
 *   API_URL=https://… DEVICE_ID=… DEVICE_SECRET=… pnpm --filter @samtec/api mock:devices -- --users 1,2,3 --shift day
 *
 * The device secret comes from an environment variable, never an option:
 * other users on the computer can read a program's options, but not its
 * environment. Your shell may still remember the command, so rotate the
 * device's secret after the demo.
 */
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { isOnThisComputer } from '../src/config/local-database.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DEMO_DEVICES, demoDeviceSecret } from './demo-devices.js';
import {
  planPunches,
  SHIFTS,
  type SimulatedDevice,
  type SimulatedGuard,
  type SimulatedPunch,
  sendHeartbeat,
  sendPunches,
} from './device-simulator.js';

const DEMO_COMPANY_ID = '01927c3e-0000-7000-8000-000000000001';

const { values } = parseArgs({
  // pnpm passes its `--` separator through, which would end the options.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    days: { type: 'string', default: '30' },
    users: { type: 'string' },
    shift: { type: 'string', default: 'day' },
  },
});
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 60) {
  throw new Error('--days must be a whole number from 1 to 60.');
}

if (process.env.DEVICE_ID || process.env.DEVICE_SECRET) {
  await playOneDevice();
} else {
  await playDemoCompany();
}

/** One device given by the environment, against any API. No database needed. */
async function playOneDevice(): Promise<void> {
  const { API_URL: apiUrl, DEVICE_ID: id, DEVICE_SECRET: secret } = process.env;
  if (!apiUrl || !id || !secret) {
    throw new Error('Set API_URL, DEVICE_ID and DEVICE_SECRET together.');
  }
  const shift = SHIFTS[values.shift as keyof typeof SHIFTS];
  if (!shift) {
    throw new Error(`--shift must be one of ${Object.keys(SHIFTS).join(', ')}.`);
  }
  const refs = (values.users ?? '').split(',').filter((ref) => /^\d{1,9}$/.test(ref));
  if (refs.length === 0) {
    throw new Error(
      'Pass --users with the staff-number digits enrolled on the device, like 1,2,3.',
    );
  }
  const device: SimulatedDevice = { apiUrl, id, secret };
  const punches = planPunches({
    guards: refs.map((deviceUserRef) => ({ deviceUserRef, ...shift })),
    days,
    now: new Date(),
  });
  const summary = await sendPunches(device, punches);
  await sendHeartbeat(device);
  console.log(
    `Sent ${punches.length} punches: ${summary.accepted} new, ${summary.duplicates} already there, ${summary.conflicts} conflicts.`,
  );
}

/** Every seeded demo device, on this computer's API and database. */
async function playDemoCompany(): Promise<void> {
  loadEnvFile();
  const env = parseEnv(process.env);
  refuseRemoteDatabase(env.DATABASE_URL);
  const apiUrl = process.env.API_URL ?? `http://localhost:${env.PORT}/api/v1`;
  await fetch(`${apiUrl}/health`).catch(() => {
    throw new Error(`No API answers at ${apiUrl}. Start it first with \`pnpm dev:api\`.`);
  });

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const devices = await prisma.device.findMany({
      where: { companyId: DEMO_COMPANY_ID, name: { in: DEMO_DEVICES.map((demo) => demo.name) } },
      include: { site: { select: { code: true } } },
    });
    if (devices.length === 0) {
      throw new Error('There are no demo devices yet. Run `pnpm db:seed` first.');
    }

    // Who is posted where, and on which shift: the roster decides the punches.
    const postings = await prisma.siteAssignment.findMany({
      where: {
        companyId: DEMO_COMPANY_ID,
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
        employee: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
      },
      include: { employee: true, shiftPattern: true },
      orderBy: { employee: { staffNumber: 'asc' } },
    });
    const refOf = (staffNumber: string) => String(Number(staffNumber.replace('SMT-', '')));
    const guardsAt = (siteId: string): SimulatedGuard[] =>
      postings
        .filter((posting) => posting.siteId === siteId && posting.employee.status === 'ACTIVE')
        .map((posting) => ({
          deviceUserRef: refOf(posting.employee.staffNumber),
          startMinutes: posting.shiftPattern?.startMinutes ?? SHIFTS.day.startMinutes,
          endMinutes: posting.shiftPattern?.endMinutes ?? SHIFTS.day.endMinutes,
        }));

    // The planted story, so the exception queue has one of everything.
    const extras = new Map<string, SimulatedPunch[]>();
    const plant = (siteCode: string, punch: SimulatedPunch) =>
      extras.set(siteCode, [...(extras.get(siteCode) ?? []), punch]);
    const at = (daysAgo: number, hours: number) =>
      new Date(today.getTime() - daysAgo * 86_400_000 + hours * 3_600_000).toISOString();
    const firstAtAccra = guardsAt(devices.find((d) => d.site.code === 'ACC-01')?.siteId ?? '')[0];
    if (firstAtAccra) {
      // One guard "at two sites at once", on a day they really worked at ACC-01:
      // the evidence the bilocation ghost rule (R4) will need.
      const own = planPunches({ guards: [firstAtAccra], days, now });
      const worked = own.filter(
        (punch) =>
          punch.deviceEventId.endsWith('-in') &&
          own.some((other) => other.deviceEventId === punch.deviceEventId.replace(/-in$/, '-out')),
      );
      const shiftStart = worked.at(-3)?.deviceTime;
      if (shiftStart) {
        const ref = firstAtAccra.deviceUserRef;
        const hoursIn = (hours: number) =>
          new Date(Date.parse(shiftStart) + hours * 3_600_000).toISOString();
        plant('ACC-02', {
          deviceEventId: `planted-${ref}-overlap-in`,
          deviceUserRef: ref,
          deviceTime: hoursIn(4),
          direction: 'IN',
          method: 'FINGERPRINT',
        });
        plant('ACC-02', {
          deviceEventId: `planted-${ref}-overlap-out`,
          deviceUserRef: ref,
          deviceTime: hoursIn(6),
          direction: 'OUT',
          method: 'FINGERPRINT',
        });
      }
    }
    // A number nobody is enrolled under.
    plant('ACC-01', {
      deviceEventId: 'planted-99001-in',
      deviceUserRef: '99001',
      deviceTime: at(2, 7),
      direction: 'IN',
      method: 'FINGERPRINT',
    });
    // A suspended guard who still came to work one day.
    const suspended = postings.find((posting) => posting.employee.status === 'SUSPENDED');
    const suspendedSite = devices.find((device) => device.siteId === suspended?.siteId)?.site.code;
    if (suspended && suspendedSite) {
      const ref = refOf(suspended.employee.staffNumber);
      plant(suspendedSite, {
        deviceEventId: `planted-${ref}-suspended-in`,
        deviceUserRef: ref,
        deviceTime: at(1, 6),
        direction: 'IN',
        method: 'FINGERPRINT',
      });
    }

    for (const row of devices) {
      const demo = DEMO_DEVICES.find((candidate) => candidate.name === row.name);
      const device: SimulatedDevice = {
        apiUrl,
        id: row.id,
        secret: demoDeviceSecret(env.AUTH_SECRET, row.name),
        clockDriftSeconds: demo?.clockDriftSeconds,
      };
      const guards = guardsAt(row.siteId);
      const punches = [
        ...planPunches({ guards, days, now, clockDriftSeconds: demo?.clockDriftSeconds }),
        ...(extras.get(row.site.code) ?? []),
      ].sort((a, b) => a.deviceTime.localeCompare(b.deviceTime));
      const summary = await sendPunches(device, punches, {
        resendLastBatch: demo?.resendsLastBatch,
      });
      await sendHeartbeat(device);
      console.log(
        `${row.name}: ${guards.length} guards, ${punches.length} punches → ${summary.accepted} new, ${summary.duplicates} duplicates, ${summary.conflicts} conflicts.`,
      );
    }
    console.log(
      'Done. See the shifts and the queue with `pnpm --filter @samtec/api db:studio` (work_segments, attendance_exceptions), or on the dashboard once its attendance pages exist.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** The demo plays a database on this computer only, like `pnpm db:seed`. */
function refuseRemoteDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!isOnThisComputer(url)) {
    throw new Error(
      `Refusing to play the demo against the database at "${host}". To use another API, set API_URL, DEVICE_ID and DEVICE_SECRET instead.`,
    );
  }
}
