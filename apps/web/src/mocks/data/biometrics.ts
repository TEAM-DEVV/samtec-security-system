import type {
  BiometricCollision,
  ClockInAttempt,
  EmployeeBiometrics,
  EmployeeRef,
  PunchFeedItem,
} from '@samtec/contracts';
import { mockSegments } from './attendance';
import { mockDevices } from './devices';
import { mockEmployees } from './employees';

// Fictional biometric statuses only (see SECURITY.md). No image, template or
// embedding exists anywhere in the mock API, just like the real one.

const kiosk = mockDevices.find((device) => device.kind === 'FACE_KIOSK');
const KIOSK_ID = kiosk?.id ?? '';
const KIOSK_NAME = kiosk?.name ?? 'Kiosk';
/** A second, fictional administrator did these enrollments, so the mock admin may review them. */
const OTHER_ADMIN_ID = '01927c3e-2222-7ccc-9ddd-000000000099';

export const CONSENT_TEXT = [
  'SAMTEC uses your face, and a fingerprint on this device if it has a sensor, only to record when you start and end your shifts, so that you are paid correctly.',
  'We keep numbers measured from your face, never a photo. Fingerprints stay inside the device; we keep only a key it unlocks.',
  'Your data is encrypted, is never shared, and is deleted 90 days after you leave the company.',
  'You may say no, or withdraw later: a supervisor then confirms your clock-ins instead, and you are paid exactly the same.',
].join('\n\n');
export const CONSENT_VERSION = 'bio-v1';
/** SHA-256 of `CONSENT_TEXT` (UTF-8), worked out once; a test checks it still matches. */
export const CONSENT_SHA256 = '064a749ac3ed2d07c4c051ec4584913a05ccdbe237efcbd37c4b246ce0169f7c';

function refOf(employeeId: string): EmployeeRef {
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);
  if (!employee) throw new Error(`No mock employee ${employeeId}`);
  return { id: employee.id, staffNumber: employee.staffNumber, fullName: employee.fullName };
}

/** Everyone enrolled has consent and an active face; new starters have nothing yet. */
export const mockBiometrics: EmployeeBiometrics[] = mockEmployees.map((employee, index) => {
  const enrolled = employee.biometricEnrolledAt !== null;
  return {
    employeeId: employee.id,
    consent: enrolled
      ? { status: 'GIVEN', textVersion: CONSENT_VERSION, at: employee.biometricEnrolledAt }
      : { status: 'NONE', textVersion: null, at: null },
    face: enrolled
      ? {
          status: 'ACTIVE',
          dedupe: 'PASSED',
          enrolledAt: employee.biometricEnrolledAt,
          deviceName: KIOSK_NAME,
        }
      : { status: 'NONE', dedupe: null, enrolledAt: null, deviceName: null },
    // The first few enrolled people also saved a finger on the kiosk's sensor.
    passkeys:
      enrolled && index < 6
        ? [
            {
              id: `01927c3e-6666-7aaa-8bbb-${String(index + 1).padStart(12, '0')}`,
              deviceId: KIOSK_ID,
              deviceName: KIOSK_NAME,
              registeredAt: employee.biometricEnrolledAt ?? '',
              synced: false,
              revokedAt: null,
            },
          ]
        : [],
    exemption: null,
  };
});

const pending = mockEmployees.filter((employee) => employee.status === 'PENDING_ENROLLMENT');
const enrolledPeople = mockEmployees.filter((employee) => employee.biometricEnrolledAt !== null);

// The planted ghost story: a new starter whose face looks like someone already enrolled.
const suspect = pending[0];
const lookalike = enrolledPeople[4];
if (suspect && lookalike) {
  const record = mockBiometrics.find((row) => row.employeeId === suspect.id);
  if (record) {
    record.consent = { status: 'GIVEN', textVersion: CONSENT_VERSION, at: '2026-09-21T09:00:00Z' };
    record.face = {
      status: 'PENDING',
      dedupe: 'COLLISION',
      enrolledAt: '2026-09-21T09:02:00Z',
      deviceName: KIOSK_NAME,
    };
  }
}

// A new starter who said no: one ADMIN asked for an exemption, and a second
// ADMIN (the mock admin) still has to approve or reject it.
const refuser = pending[1];
if (refuser) {
  const record = mockBiometrics.find((row) => row.employeeId === refuser.id);
  if (record) {
    record.exemption = {
      status: 'REQUESTED',
      reason: 'DECLINED',
      note: 'Declined in writing at the kiosk on 19 September.',
      requestedAt: '2026-09-19T11:00:00Z',
      requestedByUserId: OTHER_ADMIN_ID,
      reviewedAt: null,
      reviewedByUserId: null,
    };
  }
}

// A working guard who withdrew consent: the face is wiped, and the exemption
// followed at once, because they had already passed the duplicate check.
const withdrawer = enrolledPeople[5];
if (withdrawer) {
  const record = mockBiometrics.find((row) => row.employeeId === withdrawer.id);
  if (record) {
    record.consent = {
      status: 'WITHDRAWN',
      textVersion: CONSENT_VERSION,
      at: '2026-09-18T10:00:00Z',
    };
    record.face = { ...record.face, status: 'REVOKED' };
    record.passkeys = record.passkeys.map((key) => ({ ...key, revokedAt: '2026-09-18T10:00:00Z' }));
    record.exemption = {
      status: 'APPROVED',
      reason: 'CONSENT_WITHDRAWN',
      note: 'Withdrew consent in writing.',
      requestedAt: '2026-09-18T10:00:00Z',
      requestedByUserId: OTHER_ADMIN_ID,
      reviewedAt: null,
      reviewedByUserId: null,
    };
  }
}

/** The duplicate-enrollment queue: one open case, one already decided. Only ADMINs see it. */
export const mockCollisions: BiometricCollision[] = [
  ...(suspect && lookalike
    ? [
        {
          credentialId: '01927c3e-7777-7aaa-8bbb-000000000001',
          status: 'OPEN' as const,
          employee: refOf(suspect.id),
          lookedLike: refOf(lookalike.id),
          similarity: 0.71,
          enrolledAt: '2026-09-21T09:02:00Z',
          enrolledByUserId: OTHER_ADMIN_ID,
          deviceId: KIOSK_ID,
          resolution: null,
        },
      ]
    : []),
  ...(enrolledPeople[1] && enrolledPeople[2]
    ? [
        {
          credentialId: '01927c3e-7777-7aaa-8bbb-000000000002',
          status: 'RESOLVED' as const,
          employee: refOf(enrolledPeople[1].id),
          lookedLike: refOf(enrolledPeople[2].id),
          similarity: 0.62,
          enrolledAt: '2026-09-10T08:30:00Z',
          enrolledByUserId: OTHER_ADMIN_ID,
          deviceId: KIOSK_ID,
          resolution: {
            verdict: 'DIFFERENT_PEOPLE' as const,
            keptEmployeeId: null,
            note: 'Brothers; both Ghana Cards checked in person.',
            resolvedAt: '2026-09-10T10:00:00Z',
            resolvedByUserId: '01927c3e-2222-7ccc-9ddd-000000000001',
          },
        },
      ]
    : []),
];

/**
 * Every worked shift's clock-in and clock-out, as punches: mostly from the
 * sites' fingerprint terminals, some from the ACC-01 kiosk (face, then the
 * device's fingerprint sensor), and a few flagged ones.
 */
export const mockPunches: PunchFeedItem[] = mockSegments
  .filter((segment) => segment.basis !== 'MANUAL')
  .flatMap((segment, index) => {
    const atKiosk = segment.siteId === kiosk?.siteId && index % 3 === 0;
    const device = atKiosk
      ? kiosk
      : mockDevices.find(
          (candidate) => candidate.siteId === segment.siteId && candidate.kind !== 'FACE_KIOSK',
        );
    const method = atKiosk ? 'FACE_PASSKEY' : index % 17 === 0 ? 'PIN_FALLBACK' : 'FINGERPRINT';
    const punch = (at: string, direction: 'IN' | 'OUT', n: number): PunchFeedItem => ({
      id: `01927c3e-8888-7aaa-8bbb-${String(index * 2 + n).padStart(12, '0')}`,
      employee: segment.employee,
      deviceUserRef: segment.employee.staffNumber.replace('SMT-', ''),
      siteId: segment.siteId,
      deviceId: device?.id ?? KIOSK_ID,
      deviceName: device?.name ?? KIOSK_NAME,
      deviceTime: at,
      serverTime: new Date(Date.parse(at) + 3_000).toISOString(),
      direction,
      method,
      clockSuspect: false,
    });
    return [punch(segment.startedAt, 'IN', 1), punch(segment.endedAt, 'OUT', 2)];
  })
  .sort((a, b) => b.serverTime.localeCompare(a.serverTime));

/** Recent kiosk attempts: the matches behind the kiosk punches, and two failures. */
export const mockAttempts: ClockInAttempt[] = mockPunches
  .filter((punch) => punch.method === 'FACE_PASSKEY')
  .slice(0, 6)
  .map(
    (punch, index): ClockInAttempt => ({
      id: `01927c3e-9999-7aaa-8bbb-${String(index + 1).padStart(12, '0')}`,
      deviceId: KIOSK_ID,
      deviceName: KIOSK_NAME,
      purpose: 'CLOCK',
      outcome: 'MATCHED',
      employee: punch.employee,
      attemptedAt: punch.deviceTime,
      punchId: punch.id,
    }),
  )
  .concat([
    {
      id: '01927c3e-9999-7aaa-8bbb-000000000101',
      deviceId: KIOSK_ID,
      deviceName: KIOSK_NAME,
      purpose: 'CLOCK',
      outcome: 'LOW_LIVENESS',
      employee: null,
      attemptedAt: '2026-09-21T06:59:10Z',
      punchId: null,
    },
    {
      id: '01927c3e-9999-7aaa-8bbb-000000000102',
      deviceId: KIOSK_ID,
      deviceName: KIOSK_NAME,
      purpose: 'CLOCK',
      outcome: 'NOT_RECOGNISED',
      employee: null,
      attemptedAt: '2026-09-21T06:59:40Z',
      punchId: null,
    },
  ])
  .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
