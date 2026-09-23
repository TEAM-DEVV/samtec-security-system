import { HttpException, HttpStatus } from '@nestjs/common';
import { hasDatabaseCode } from '../../common/prisma-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Every change to one company's attendance (an ingest batch, a heartbeat's
 * overdue check, a resolution) runs one at a time, under this lock, so two
 * requests can never plan against the same state.
 *
 * - It is a PostgreSQL *transaction* lock: it is released when the
 *   transaction ends, whatever happens, so it works through connection poolers.
 * - Waiting is capped at 10 seconds (`lock_timeout`); the caller then gets a
 *   503 and retries — for a device, resending is always safe.
 * - A transaction left idle is killed after 30 seconds
 *   (`idle_in_transaction_session_timeout`), so a server that crashed
 *   mid-request can never freeze a company.
 */
export async function lockCompanyAttendance(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
  await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '30s'`;
  // $executeRaw, not $queryRaw: the lock function returns nothing to read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attendance:${companyId}`}, 0))`;
}

/**
 * Enrollment takes its own lock, so a duplicate check never waits behind a
 * batch of punches and punches never wait behind an enrollment. Two
 * enrollments in the same company still take turns, which is the point: both
 * must see the other's face (docs/plan/13 section 2).
 */
export async function lockCompanyBiometrics(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
  await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '30s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`biometrics:${companyId}`}, 0))`;
}

/** How long a transaction that holds the lock may run in total, safely below Vercel's 30 s. */
export const ATTENDANCE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 25_000 } as const;

/** The API's answer while another batch of the same company holds the lock. */
export class AttendanceBusyException extends HttpException {
  readonly retryAfterSeconds = 5;

  constructor() {
    super(
      'The API is busy with another batch for this company. Send the same request again in a few seconds.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** True for PostgreSQL's "could not get the lock in time" (SQLSTATE 55P03). */
export function isLockTimeout(error: unknown): boolean {
  return hasDatabaseCode(error, '55P03');
}

/**
 * True for PostgreSQL's "these two transactions were each waiting for the
 * other" (SQLSTATE 40P01). One of them is cancelled, and the work it was
 * doing never happened, so sending the same request again is always safe —
 * which is what the caller should be told, rather than "something broke".
 */
export function isDeadlock(error: unknown): boolean {
  return hasDatabaseCode(error, '40P01');
}
