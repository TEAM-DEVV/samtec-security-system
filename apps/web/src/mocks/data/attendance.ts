import type {
  AttendanceException,
  Employee,
  EmployeeRef,
  PunchSummary,
  WorkSegment,
} from '@samtec/contracts';
import { mockDevices } from './devices';
import { mockEmployees } from './employees';
import { mockSites } from './sites';

/**
 * Fictional attendance for the mock API: two weeks of day shifts for every
 * active, posted employee, plus one example of each exception type. Built
 * relative to today, so the Attendance pages always have something to show.
 */

const DAYS = 14;
const DAY_MS = 86_400_000;

function mockId(group: string, n: number): string {
  return `01927c3e-${group}-7eee-8fff-${String(n).padStart(12, '0')}`;
}

/** Today's date at midnight UTC (Ghana is UTC+0 all year). */
function startOfTodayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function refOf(employee: Employee): EmployeeRef {
  return { id: employee.id, staffNumber: employee.staffNumber, fullName: employee.fullName };
}

const byName = (firstName: string) => {
  const employee = mockEmployees.find((candidate) => candidate.firstName === firstName);
  if (!employee) throw new Error(`No mock employee called ${firstName}`);
  return employee;
};
const siteByCode = (code: string) => {
  const site = mockSites.find((candidate) => candidate.code === code);
  if (!site) throw new Error(`No mock site ${code}`);
  return site;
};
const deviceAt = (siteId: string) => {
  const device = mockDevices.find((candidate) => candidate.siteId === siteId);
  if (!device) throw new Error('No mock device at that site');
  return device;
};

const today = startOfTodayUtc();
const dayStart = (daysAgo: number) => today - daysAgo * DAY_MS;

let punchCounter = 0;
function punch(
  employeeRef: string,
  siteId: string,
  at: number,
  direction: PunchSummary['direction'],
): PunchSummary {
  punchCounter += 1;
  const device = deviceAt(siteId);
  return {
    id: mockId('7777', punchCounter),
    deviceId: device.id,
    deviceName: device.name,
    deviceUserRef: employeeRef,
    deviceTime: new Date(at).toISOString(),
    serverTime: new Date(at + 20_000).toISOString(),
    direction,
    method: 'FINGERPRINT',
    clockSuspect: false,
  };
}

let segmentCounter = 0;
function segment(
  employee: Employee,
  siteId: string,
  startMs: number,
  endMs: number,
  status: WorkSegment['status'] = 'CONFIRMED',
): WorkSegment {
  segmentCounter += 1;
  return {
    id: mockId('5555', segmentCounter),
    employee: refOf(employee),
    siteId,
    workDate: isoDate(startMs - (startMs % DAY_MS)),
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    workedMinutes: Math.floor((endMs - startMs) / 60_000),
    basis: 'BIOMETRIC',
    status,
    clockInPunchId: mockId('7777', 900_000 + segmentCounter * 2),
    clockOutPunchId: mockId('7777', 900_001 + segmentCounter * 2),
  };
}

const kwame = byName('Kwame');
const akua = byName('Akua');
const grace = byName('Grace');
const ibrahim = byName('Ibrahim');

/** Days where the story below replaces the normal shift. */
const skipped = new Set([`${kwame.id}:1`, `${akua.id}:2`, `${ibrahim.id}:4`]);

// Two weeks of day shifts, 06:00–18:00 give or take a few minutes, one rest day in seven.
const routine: WorkSegment[] = [];
mockEmployees
  .filter((employee) => employee.status === 'ACTIVE' && employee.currentSite)
  .forEach((employee, index) => {
    for (let daysAgo = DAYS; daysAgo >= 1; daysAgo -= 1) {
      if ((daysAgo + index) % 7 === 0 || skipped.has(`${employee.id}:${daysAgo}`)) {
        continue;
      }
      const jitterIn = ((index * 7 + daysAgo * 3) % 17) - 8; // -8 .. +8 minutes
      const jitterOut = ((index * 5 + daysAgo * 11) % 23) - 5; // -5 .. +17 minutes
      const start = dayStart(daysAgo) + 6 * 3_600_000 + jitterIn * 60_000;
      const end = dayStart(daysAgo) + 18 * 3_600_000 + jitterOut * 60_000;
      routine.push(segment(employee, employee.currentSite?.id ?? '', start, end));
    }
  });

// One person on two shifts at once: Ibrahim at Kumasi and, for two hours, at Takoradi.
const ksi = siteByCode('KSI-01');
const tkd = siteByCode('TKD-01');
const overlapA = segment(
  ibrahim,
  ksi.id,
  dayStart(4) + 6 * 3_600_000,
  dayStart(4) + 18 * 3_600_000,
  'DISPUTED',
);
const overlapB = segment(
  ibrahim,
  tkd.id,
  dayStart(4) + 10 * 3_600_000,
  dayStart(4) + 12 * 3_600_000,
  'DISPUTED',
);

export const mockSegments: WorkSegment[] = [...routine, overlapA, overlapB];

function exception(
  n: number,
  fields: Pick<AttendanceException, 'type' | 'siteId' | 'employee' | 'occurredAt' | 'punch'> &
    Partial<AttendanceException>,
): AttendanceException {
  return {
    id: mockId('6666', n),
    status: 'OPEN',
    secondSiteId: null,
    workDate: fields.occurredAt.slice(0, 10),
    segments: [],
    resolution: null,
    resolutionSegmentId: null,
    allowedActions: [],
    createdAt: fields.occurredAt,
    ...fields,
  };
}

const acc01 = siteByCode('ACC-01');
const acc02 = siteByCode('ACC-02');
const tem01 = siteByCode('TEM-01');
const kwameIn = punch('1', acc01.id, dayStart(1) + 5 * 3_600_000 + 58 * 60_000, 'IN');
const akuaOut = punch('4', acc02.id, dayStart(2) + 18 * 3_600_000 + 5 * 60_000, 'OUT');
const strangerIn = punch('99001', acc01.id, dayStart(3) + 6 * 3_600_000 + 2 * 60_000, 'IN');
const graceIn = punch('6', tem01.id, dayStart(2) + 6 * 3_600_000 + 1 * 60_000, 'IN');

/** One example of every exception type, all waiting for a person. */
export const mockExceptions: AttendanceException[] = [
  exception(1, {
    type: 'MISSING_CLOCK_OUT',
    siteId: acc01.id,
    employee: refOf(kwame),
    occurredAt: kwameIn.deviceTime,
    punch: kwameIn,
  }),
  exception(2, {
    type: 'MISSING_CLOCK_IN',
    siteId: acc02.id,
    employee: refOf(akua),
    occurredAt: akuaOut.deviceTime,
    punch: akuaOut,
  }),
  exception(3, {
    type: 'UNKNOWN_EMPLOYEE',
    siteId: acc01.id,
    employee: null,
    occurredAt: strangerIn.deviceTime,
    punch: strangerIn,
  }),
  exception(4, {
    type: 'INACTIVE_EMPLOYEE',
    siteId: tem01.id,
    employee: refOf(grace),
    occurredAt: graceIn.deviceTime,
    punch: graceIn,
  }),
  exception(5, {
    type: 'OVERLAP',
    siteId: ksi.id,
    secondSiteId: tkd.id,
    employee: refOf(ibrahim),
    occurredAt: overlapB.startedAt,
    punch: null,
    segments: [overlapB, overlapA],
  }),
];
