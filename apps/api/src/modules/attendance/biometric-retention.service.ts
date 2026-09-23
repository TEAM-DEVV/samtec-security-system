import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { EmployeesService } from '../workforce/employees.service.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS,
  isLockTimeout,
  lockCompanyBiometrics,
} from './attendance-lock.js';
import { MAX_SHIFT_MS } from './pairing.js';

/** How long a face is kept after the worker leaves (docs/plan/13 section 2). */
export const RETENTION_DAYS = 90;

/** At most this many people per heartbeat, so one transaction stays small. */
export const PEOPLE_PER_SWEEP = 50;

/** The sweep runs at most once a day; kiosks send a heartbeat every minute. */
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention sweep (docs/plan/13 section 2, "Deletion (Act 843)").
 *
 * Ghana's Data Protection Act says personal data is kept only as long as it
 * is needed. Faces are needed while somebody works here, plus 90 days — long
 * enough to catch a leaver coming back under a new name. Nobody has to
 * remember to do it: the sweep rides on the device heartbeat, exactly like
 * the overdue clock-out check, so there is no scheduled job and no extra
 * secret to look after.
 *
 * Each heartbeat asks "has a day passed since the last sweep?". If it has,
 * one batch of at most 50 people is cleaned up and the bookmark moves
 * forward. A full batch leaves the bookmark where it is, so the very next
 * heartbeat carries on with the rest.
 *
 * What it never touches: a record blocked as a duplicate (it is already
 * wiped and stays blocked forever), and an open duplicate review (only a
 * second ADMIN closes one — the face goes, the question stays).
 */
@Injectable()
export class BiometricRetentionService {
  private readonly logger = new Logger(BiometricRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
  ) {}

  /**
   * Runs one batch if a day has passed. Called from the heartbeat, so it
   * never fails the heartbeat: a device that cannot check in is worse than a
   * sweep that waits for the next minute.
   */
  async sweep(companyId: string, now: Date): Promise<SweepResult> {
    try {
      return await this.runBatch(companyId, now);
    } catch (error) {
      if (isLockTimeout(error)) {
        return { ran: false, people: 0 };
      }
      // IDs and the message only: never a name, a card number or a template.
      this.logger.error(
        `The retention sweep for company ${companyId} could not finish`,
        error instanceof Error ? error.stack : undefined,
      );
      return { ran: false, people: 0 };
    }
  }

  private async runBatch(companyId: string, now: Date): Promise<SweepResult> {
    if (!(await this.isDue(this.prisma, companyId, now))) {
      return { ran: false, people: 0 };
    }
    return this.prisma.$transaction(async (tx) => {
      await lockCompanyBiometrics(tx, companyId);
      // Read again under the lock: another heartbeat may have just swept.
      if (!(await this.isDue(tx, companyId, now))) {
        return { ran: false, people: 0 };
      }
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
      const people = await this.peopleToClean(tx, companyId, now, cutoff);
      if (people.length > 0) {
        await lockWorkers(tx, people);
        await this.revokeKeysOfLeavers(tx, companyId, people, now);
        await this.wipeFaces(tx, companyId, people, now, cutoff);
        await this.clearNotesAndAddresses(tx, companyId, people, cutoff);
      }
      // A full batch means there is probably more: leave the bookmark alone
      // so the next heartbeat (a minute later) carries on.
      if (people.length < PEOPLE_PER_SWEEP) {
        await this.moveBookmark(tx, companyId, now);
      }
      return { ran: true, people: people.length };
    }, ATTENDANCE_TRANSACTION_OPTIONS);
  }

  /** True when this company has never swept, or last swept over a day ago. */
  private async isDue(
    db: Prisma.TransactionClient | PrismaService,
    companyId: string,
    now: Date,
  ): Promise<boolean> {
    const bookmark = await db.attendanceCheck.findUnique({ where: { companyId } });
    const last = bookmark?.retentionCheckedAt;
    return last === null || last === undefined || now.getTime() - last.getTime() >= SWEEP_EVERY_MS;
  }

  /**
   * The people with something to clean up, at most 50, always the same order,
   * so the next heartbeat takes the next 50:
   *
   * - anyone terminated, whose fingerprint keys are still on;
   * - anyone terminated 90 days ago, who still has a face, an exemption note
   *   or an attempt with a network address;
   * - anyone whose face has waited 90 days for a duplicate review, or who was
   *   enrolled 90 days ago and never came back (an abandoned hire).
   */
  private async peopleToClean(
    tx: Prisma.TransactionClient,
    companyId: string,
    now: Date,
    cutoff: Date,
  ): Promise<string[]> {
    // `groupBy` (a real GROUP BY … LIMIT), not `findMany` + `distinct`, so
    // "50" really means 50 people and the batch always makes progress.
    const left = { status: 'TERMINATED' as const, terminationDate: { lte: cutoff } };
    const [keys, faces, stale, notes, addresses] = await Promise.all([
      tx.devicePasskey.groupBy({
        by: ['employeeId'],
        orderBy: { employeeId: 'asc' },
        take: PEOPLE_PER_SWEEP,
        where: {
          companyId,
          revokedAt: null,
          employee: { status: 'TERMINATED', terminationDate: { lte: now } },
        },
      }),
      tx.biometricCredential.groupBy({
        by: ['employeeId'],
        orderBy: { employeeId: 'asc' },
        take: PEOPLE_PER_SWEEP,
        where: { companyId, wipedAt: null, employee: left },
      }),
      // A face still live 90 days after enrollment, on a worker who never
      // started: either a review nobody answered or a hire that went away.
      tx.biometricCredential.groupBy({
        by: ['employeeId'],
        orderBy: { employeeId: 'asc' },
        take: PEOPLE_PER_SWEEP,
        where: {
          companyId,
          kind: 'FACE',
          wipedAt: null,
          enrolledAt: { lte: cutoff },
          employee: { status: 'PENDING_ENROLLMENT' },
        },
      }),
      tx.biometricExemption.groupBy({
        by: ['employeeId'],
        orderBy: { employeeId: 'asc' },
        take: PEOPLE_PER_SWEEP,
        where: { companyId, note: { not: null }, employee: left },
      }),
      tx.clockInAttempt.groupBy({
        by: ['employeeId'],
        orderBy: { employeeId: 'asc' },
        take: PEOPLE_PER_SWEEP,
        where: { companyId, clientAddress: { not: null }, employee: left },
      }),
    ]);
    const everyone = [...keys, ...faces, ...stale, ...notes, ...addresses]
      .map((row) => row.employeeId)
      .filter((id): id is string => id !== null);
    return [...new Set(everyone)].sort().slice(0, PEOPLE_PER_SWEEP);
  }

  /**
   * A leaver's fingerprint keys go off on their last day, long before the
   * face goes: nobody who has left should be able to clock in at all.
   * `revokedByUserId` stays empty, which is how the sweep signs its work.
   */
  private async revokeKeysOfLeavers(
    tx: Prisma.TransactionClient,
    companyId: string,
    people: string[],
    now: Date,
  ): Promise<void> {
    await tx.devicePasskey.updateMany({
      where: {
        companyId,
        employeeId: { in: people },
        revokedAt: null,
        employee: { status: 'TERMINATED', terminationDate: { lte: now } },
      },
      data: { revokedAt: now, revokedByUserId: null },
    });
  }

  /**
   * Wipes the numbers themselves. The row stays (nothing is ever deleted),
   * and so does an open review: its verdict is still empty, so it is still
   * in the queue, and the second ADMIN decides it from the Ghana Cards.
   *
   * `REVOKED`, never `BLOCKED`: only a SAME_PERSON decision blocks a record,
   * and a blocked one is already wiped, so the sweep passes it by.
   */
  private async wipeFaces(
    tx: Prisma.TransactionClient,
    companyId: string,
    people: string[],
    now: Date,
    cutoff: Date,
  ): Promise<void> {
    const wipe = {
      status: 'REVOKED' as const,
      templateSealed: null,
      keyVersion: null,
      wipedAt: now,
    };
    const [leavers, abandoned] = await Promise.all([
      tx.biometricCredential.updateManyAndReturn({
        where: {
          companyId,
          employeeId: { in: people },
          wipedAt: null,
          employee: { status: 'TERMINATED', terminationDate: { lte: cutoff } },
        },
        data: wipe,
        select: { employeeId: true },
      }),
      tx.biometricCredential.updateManyAndReturn({
        where: {
          companyId,
          employeeId: { in: people },
          kind: 'FACE',
          wipedAt: null,
          enrolledAt: { lte: cutoff },
          employee: { status: 'PENDING_ENROLLMENT' },
        },
        data: wipe,
        select: { employeeId: true },
      }),
    ]);
    for (const employeeId of new Set([...leavers, ...abandoned].map((row) => row.employeeId))) {
      // The worker no longer counts as enrolled. A leaver stays TERMINATED;
      // this only moves somebody still waiting back to PENDING_ENROLLMENT.
      await this.employees.clearBiometricsEnrolled(companyId, employeeId, tx);
    }
  }

  /**
   * The words go, the facts stay: an exemption keeps its reason code and its
   * dates, an attempt keeps its outcome and its scores. Only the free text
   * and the network address — the parts that describe a person rather than
   * the attendance — are cleared.
   */
  private async clearNotesAndAddresses(
    tx: Prisma.TransactionClient,
    companyId: string,
    people: string[],
    cutoff: Date,
  ): Promise<void> {
    const gone = { status: 'TERMINATED' as const, terminationDate: { lte: cutoff } };
    await tx.biometricExemption.updateMany({
      where: { companyId, employeeId: { in: people }, note: { not: null }, employee: gone },
      data: { note: null },
    });
    await tx.clockInAttempt.updateMany({
      where: {
        companyId,
        employeeId: { in: people },
        clientAddress: { not: null },
        employee: gone,
      },
      data: { clientAddress: null },
    });
  }

  /** Moves the bookmark forward, creating the company's row the first time. */
  private async moveBookmark(
    tx: Prisma.TransactionClient,
    companyId: string,
    now: Date,
  ): Promise<void> {
    const moved = await tx.attendanceCheck.updateMany({
      where: { companyId },
      data: { retentionCheckedAt: now },
    });
    if (moved.count === 0) {
      await tx.attendanceCheck.createMany({
        // The overdue check owns the other column. Starting it where that
        // check starts itself (32 hours back) leaves it whole.
        data: [
          {
            companyId,
            overdueCheckedUntil: new Date(now.getTime() - 2 * MAX_SHIFT_MS),
            retentionCheckedAt: now,
          },
        ],
        skipDuplicates: true,
      });
    }
  }
}

/** What one heartbeat's sweep did, for the tests and the heartbeat's log. */
export interface SweepResult {
  ran: boolean;
  people: number;
}

/** Takes the workers' rows in id order, so nobody deadlocks (docs/plan/13 §2). */
async function lockWorkers(tx: Prisma.TransactionClient, employeeIds: string[]): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM employees WHERE id = ANY(${employeeIds}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
}
