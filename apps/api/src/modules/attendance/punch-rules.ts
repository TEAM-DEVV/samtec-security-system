import { createHash } from 'node:crypto';
import type { EmployeeStatus } from '../../generated/prisma/enums.js';

/**
 * Small pure rules about single punches, each tested on its own
 * (`punch-rules.spec.ts`). docs/plan/12-attendance-design.md explains them.
 */

/** Punches before this are a dead clock battery, not real attendance. */
const EARLIEST_POSSIBLE = Date.parse('2020-01-01T00:00:00Z');
/** A device clock further off than this makes its punch times suspect. */
export const MAX_DRIFT_SECONDS = 300;

/**
 * The staff number a device user number stands for: the digits of the staff
 * number (`42` and `00042` mean SMT-00042), or the staff number itself.
 * ZKTeco user numbers are numeric by default, so real terminals can be
 * enrolled the same way in Phase 3. Anything else matches nobody.
 */
export function staffNumberForDeviceUser(deviceUserRef: string): string | undefined {
  if (/^SMT-\d{5}$/.test(deviceUserRef)) {
    return deviceUserRef;
  }
  if (!/^\d{1,9}$/.test(deviceUserRef)) {
    return undefined;
  }
  const number = Number(deviceUserRef);
  return number >= 1 && number <= 99_999 ? `SMT-${String(number).padStart(5, '0')}` : undefined;
}

export interface PunchFields {
  deviceEventId: string;
  deviceUserRef: string;
  deviceTime: Date;
  direction: string;
  method: string;
}

/**
 * A fingerprint of a punch's content, independent of how the JSON was laid
 * out: SHA-256 of the fields in a fixed order. A resend with the same event
 * ID but a different fingerprint was tampered with (or is a device bug).
 */
export function punchPayloadHash(punch: PunchFields): string {
  return createHash('sha256')
    .update(
      [
        punch.deviceEventId,
        punch.deviceUserRef,
        punch.deviceTime.toISOString(),
        punch.direction,
        punch.method,
      ].join('\n'),
    )
    .digest('hex');
}

/**
 * How much to trust a punch's time.
 *
 * - `pairable` is false for impossible times: before 2020, or later than the
 *   server's clock (plus 5 minutes, plus how fast the device's clock is known
 *   to run). Such punches are stored but never paired, so a fast clock can
 *   never create future hours.
 * - `clockSuspect` is true for impossible times, and when the device's clock
 *   was more than 5 minutes off when it sent the batch.
 */
export function judgePunchTime(
  deviceTime: Date,
  serverTime: Date,
  clockDriftSeconds: number | null,
): { pairable: boolean; clockSuspect: boolean } {
  const knownFastMs = Math.max(0, clockDriftSeconds ?? 0) * 1000;
  const latestPossible = serverTime.getTime() + MAX_DRIFT_SECONDS * 1000 + knownFastMs;
  const time = deviceTime.getTime();
  const pairable = time >= EARLIEST_POSSIBLE && time <= latestPossible;
  const drifted = clockDriftSeconds !== null && Math.abs(clockDriftSeconds) > MAX_DRIFT_SECONDS;
  return { pairable, clockSuspect: !pairable || drifted };
}

/**
 * True when this employee may clock in on this (Ghana) date. Those who may
 * not are still recorded — presence is a fact — but the queue is told.
 */
export function mayClockIn(
  employee: { status: EmployeeStatus; terminationDate: string | null },
  punchDate: string,
): boolean {
  // No default: a new status fails to compile until someone decides here.
  switch (employee.status) {
    case 'ACTIVE':
      return true;
    case 'PENDING_ENROLLMENT':
    case 'SUSPENDED':
      return false;
    case 'TERMINATED':
      // Final-week punches that sync late are fine; later ones are not.
      return employee.terminationDate !== null && punchDate <= employee.terminationDate;
  }
}
