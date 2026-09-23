import type {
  AttendanceExceptionStatus,
  AttendanceExceptionType,
  DeviceKind,
  DeviceStatus,
  PunchDirection,
  PunchMethod,
  SegmentBasis,
  SegmentStatus,
} from '@samtec/contracts';

/**
 * Plain words for the attendance module's codes. Each `Record<…>` makes
 * TypeScript fail the build if the contract gains a value without a label.
 */

export const SEGMENT_STATUSES: readonly SegmentStatus[] = ['CONFIRMED', 'DISPUTED', 'VOIDED'];

export const segmentStatusLabels: Record<SegmentStatus, string> = {
  CONFIRMED: 'Counted',
  DISPUTED: 'Disputed',
  VOIDED: 'Voided',
};

export const segmentBasisLabels: Record<SegmentBasis, string> = {
  BIOMETRIC: 'Biometric',
  PIN_FALLBACK: 'PIN or co-sign',
  MANUAL: 'Added by hand',
};

export const EXCEPTION_TYPES: readonly AttendanceExceptionType[] = [
  'MISSING_CLOCK_OUT',
  'MISSING_CLOCK_IN',
  'UNKNOWN_EMPLOYEE',
  'INACTIVE_EMPLOYEE',
  'OVERLAP',
  'UNEXPECTED_DEVICE_ENROLLMENT',
];

export const exceptionTypeLabels: Record<AttendanceExceptionType, string> = {
  MISSING_CLOCK_OUT: 'Missing clock-out',
  MISSING_CLOCK_IN: 'Missing clock-in',
  UNKNOWN_EMPLOYEE: 'Unknown employee',
  INACTIVE_EMPLOYEE: 'May not clock in',
  OVERLAP: 'Two shifts at once',
  UNEXPECTED_DEVICE_ENROLLMENT: 'Finger nobody asked for',
};

/** One sentence per type: what happened, and what a person can do about it. */
export const exceptionTypeDescriptions: Record<AttendanceExceptionType, string> = {
  MISSING_CLOCK_OUT:
    'A clock-in with no clock-out in the 16 hours after it. Add the shift by hand if you know when it ended, or dismiss it.',
  MISSING_CLOCK_IN:
    'A clock-out with no clock-in in the 16 hours before it. Add the shift by hand if you know when it started, or dismiss it.',
  UNKNOWN_EMPLOYEE:
    'A device user number that matches nobody. It can only be dismissed: giving an unknown punch to a person is exactly what a ghost worker needs.',
  INACTIVE_EMPLOYEE:
    'A punch from someone who may not clock in yet (waiting for enrolment, suspended, or after leaving). Their hours are recorded; payroll decides later.',
  OVERLAP:
    'One person on two shifts at the same time, often at two sites. Keep the shift that really happened, or void both.',
  UNEXPECTED_DEVICE_ENROLLMENT:
    'A ZKTeco terminal reported a fingerprint nobody asked for — outside any window an admin opened, or for a user number that matches nobody. The finger was refused, so nothing was taken. Check the terminal, then dismiss it.',
};

export const EXCEPTION_STATUSES: readonly AttendanceExceptionStatus[] = [
  'OPEN',
  'RESOLVED',
  'AUTO_CLOSED',
];

export const exceptionStatusLabels: Record<AttendanceExceptionStatus, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  AUTO_CLOSED: 'Closed by later punches',
};

export const punchDirectionLabels: Record<PunchDirection, string> = {
  IN: 'Clock-in',
  OUT: 'Clock-out',
  UNKNOWN: 'Direction not given',
};

export const punchMethodLabels: Record<PunchMethod, string> = {
  FINGERPRINT: 'Fingerprint',
  FACE: 'Face',
  FACE_PASSKEY: 'Face, then fingerprint',
  STAFF_PASSKEY: 'Staff number, then fingerprint',
  PIN_FALLBACK: 'PIN or co-sign',
};

/** Methods that do not prove who was there; the dashboard flags them. */
export function isFlaggedMethod(method: PunchMethod): boolean {
  return method === 'STAFF_PASSKEY' || method === 'PIN_FALLBACK';
}

export const DEVICE_KINDS: readonly DeviceKind[] = ['MOCK', 'ZKTECO', 'FACE_KIOSK'];

export const deviceKindLabels: Record<DeviceKind, string> = {
  MOCK: 'Simulator',
  ZKTECO: 'ZKTeco terminal',
  FACE_KIOSK: 'Face kiosk',
};

export const deviceStatusLabels: Record<DeviceStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Switched off',
};

/** The contract's rule: a clock more than 5 minutes off makes the device's punch times suspect. */
export const CLOCK_DRIFT_LIMIT_SECONDS = 300;

/** The longest a shift may be, and the furthest an OUT may follow its IN. */
export const MAX_SHIFT_HOURS = 16;

export function isSegmentStatus(value: string): value is SegmentStatus {
  return SEGMENT_STATUSES.some((status) => status === value);
}

export function isExceptionType(value: string): value is AttendanceExceptionType {
  return EXCEPTION_TYPES.some((type) => type === value);
}

export function isExceptionStatus(value: string): value is AttendanceExceptionStatus {
  return EXCEPTION_STATUSES.some((status) => status === value);
}

export function isDeviceKind(value: string): value is DeviceKind {
  return DEVICE_KINDS.some((kind) => kind === value);
}

/** The contract allows at most 31 days per segments request. */
export const MAX_RANGE_DAYS = 31;

/** Whole days between two calendar dates, negative when `to` is before `from`. */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** "7 min fast", "2 s slow", "exact", or "—" when the device has never reported. */
export function describeDrift(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds === 0) return 'exact';
  const size = Math.abs(seconds);
  const amount = size >= 60 ? `${Math.round(size / 60)} min` : `${size} s`;
  return `${amount} ${seconds > 0 ? 'fast' : 'slow'}`;
}

/** True when the device's clock is further off than the contract allows. */
export function driftIsSuspect(seconds: number | null): boolean {
  return seconds !== null && Math.abs(seconds) > CLOCK_DRIFT_LIMIT_SECONDS;
}
