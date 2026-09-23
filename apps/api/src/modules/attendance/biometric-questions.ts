import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The two questions a second ADMIN can owe a worker, as database filters, so
 * the kiosk and the dashboard ask them in exactly the same words
 * (docs/plan/13-biometrics-design.md section 2, "One open question at a
 * time").
 */

/**
 * A duplicate review this worker is part of that nobody has answered yet.
 *
 * Three things make one open, and all three matter:
 *
 * - **No verdict yet.** Not "the face is PENDING": a withdrawal of consent or
 *   the retention sweep wipes a face while its question still stands.
 * - **Either record.** A review is about two people, so it holds the worker
 *   the face looked like as fast as the worker who enrolled it.
 * - **Not blocked.** A blocked face can never be decided — the database says
 *   so ("a blocked face is never decided") — so its question is over.
 *   Without this last part, a record blocked by a *second* review would
 *   leave the first review unanswerable and hold an innocent worker for
 *   ever, with no way back into work.
 */
export function openReview(
  companyId: string,
  employeeId: string,
): Prisma.BiometricCredentialWhereInput {
  return {
    companyId,
    kind: 'FACE',
    dedupe: 'COLLISION',
    verdict: null,
    status: { not: 'BLOCKED' },
    OR: [{ employeeId }, { collisionEmployeeId: employeeId }],
  };
}

/** A record blocked as a duplicate: finished for good, whatever else happens. */
export function blockedRecord(
  companyId: string,
  employeeId: string,
): Prisma.BiometricCredentialWhereInput {
  return { companyId, employeeId, kind: 'FACE', status: 'BLOCKED' };
}
