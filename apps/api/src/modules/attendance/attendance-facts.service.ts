import { Injectable } from '@nestjs/common';
import { toAccraDate } from '../../common/dates.js';
import { PrismaService } from '../../database/prisma.service.js';

/** Minutes past midnight in Accra, asked of the time zone database. */
function accraMinuteOfDay(instant: Date): number {
  const [hour, minute] = ACCRA_CLOCK.format(instant).split(':');
  return Number(hour) * 60 + Number(minute);
}

/** Every calendar day from one moment to another, inclusive, in Accra. */
function daysBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const oneDay = 24 * 60 * 60 * 1000;
  for (let at = from.getTime(); at <= to.getTime(); at += oneDay) {
    days.push(toAccraDate(new Date(at)));
  }
  const last = toAccraDate(to);
  if (days.at(-1) !== last) {
    days.push(last);
  }
  return [...new Set(days)];
}

const ACCRA_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * What the attendance module will tell another module about its own tables.
 *
 * Ghost detection has to look at punches and the exception queue, but a
 * module writes and reads only its own tables — so the questions it needs to
 * ask live here, in the module that owns the answers, and detection calls
 * them. Each one is a counting question, never a dump: nothing here returns
 * a punch row, and nothing here leaves a company.
 */
@Injectable()
export class AttendanceFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Which of these workers have ever had a punch at all (rule R5). */
  async everPunched(companyId: string, employeeIds: readonly string[]): Promise<Set<string>> {
    if (employeeIds.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.punchEvent.groupBy({
      by: ['employeeId'],
      where: { companyId, employeeId: { in: [...employeeIds] } },
      _count: true,
    });
    return new Set(
      rows
        .map((row) => row.employeeId)
        .filter((employeeId): employeeId is string => employeeId !== null),
    );
  }

  /**
   * How many times each worker was on shift at two places at once since
   * `from` (rule R4), with the sites involved.
   *
   * It counts the `OVERLAP` exceptions Phase 2 already raises rather than
   * pairing segments again: one event is the exception queue's business, and
   * the repetition is detection's.
   */
  async overlapsPerEmployee(
    companyId: string,
    from: Date,
  ): Promise<{ employeeId: string; siteId: string; overlaps: number; siteNames: string[] }[]> {
    const rows = await this.prisma.attendanceException.findMany({
      where: { companyId, type: 'OVERLAP', occurredAt: { gte: from } },
      select: {
        employeeId: true,
        siteId: true,
        site: { select: { name: true } },
        secondSite: { select: { name: true } },
      },
    });
    const byEmployee = new Map<
      string,
      { employeeId: string; siteId: string; overlaps: number; siteNames: Set<string> }
    >();
    for (const row of rows) {
      if (row.employeeId === null) {
        continue;
      }
      const running = byEmployee.get(row.employeeId) ?? {
        employeeId: row.employeeId,
        siteId: row.siteId,
        overlaps: 0,
        siteNames: new Set<string>(),
      };
      running.overlaps += 1;
      running.siteNames.add(row.site.name);
      if (row.secondSite) {
        running.siteNames.add(row.secondSite.name);
      }
      byEmployee.set(row.employeeId, running);
    }
    return [...byEmployee.values()].map((row) => ({
      employeeId: row.employeeId,
      siteId: row.siteId,
      overlaps: row.overlaps,
      siteNames: [...row.siteNames].sort(),
    }));
  }

  /**
   * The face records still waiting on a second ADMIN's duplicate decision
   * (rule R1), with who they looked like and how closely.
   *
   * The score is here on purpose: it is the same number the duplicate queue
   * already shows an ADMIN, and the alert has the same audience. No
   * template and no image ever leaves this method.
   */
  async openFaceCollisions(companyId: string): Promise<
    {
      credentialId: string;
      employeeId: string;
      lookedLikeStaffNumber: string;
      similarity: number;
      enrolledAt: Date;
    }[]
  > {
    const rows = await this.prisma.biometricCredential.findMany({
      where: {
        companyId,
        kind: 'FACE',
        dedupe: 'COLLISION',
        verdict: null,
        collisionEmployeeId: { not: null },
        // A record another review already blocked keeps its own dedupe and
        // verdict for ever, because the database refuses to decide a blocked
        // face. Asking an investigator to decide it would be an alert nobody
        // could ever clear. The duplicate queue leaves them out for the same
        // reason (`biometric-reviews.service.ts`).
        status: { not: 'BLOCKED' },
      },
      select: {
        id: true,
        employeeId: true,
        collisionSimilarity: true,
        enrolledAt: true,
        lookalike: { select: { staffNumber: true } },
      },
    });
    return rows
      .filter((row) => row.lookalike !== null && row.collisionSimilarity !== null)
      .map((row) => ({
        credentialId: row.id,
        employeeId: row.employeeId,
        lookedLikeStaffNumber: row.lookalike?.staffNumber ?? '',
        similarity: row.collisionSimilarity ?? 0,
        enrolledAt: row.enrolledAt,
      }));
  }

  /**
   * For each worker since `from`: how many times they clocked in, and how
   * many of those went around the camera (rule R7).
   *
   * A co-sign and a staff-number-plus-finger are the two ways past a face,
   * and both are already marked on the punch. What this counts is the share.
   */
  async clockInMethodsPerEmployee(
    companyId: string,
    from: Date,
  ): Promise<{ employeeId: string; siteId: string; clockIns: number; flagged: number }[]> {
    const rows = await this.prisma.punchEvent.findMany({
      where: {
        companyId,
        employeeId: { not: null },
        direction: 'IN',
        serverTime: { gte: from },
      },
      select: { employeeId: true, siteId: true, method: true, serverTime: true },
      // Newest first, so the site on the alert is where they were last seen
      // rather than whichever row came back first.
      orderBy: { serverTime: 'desc' },
    });
    const byEmployee = new Map<
      string,
      { employeeId: string; siteId: string; clockIns: number; flagged: number }
    >();
    for (const row of rows) {
      if (row.employeeId === null) {
        continue;
      }
      const running = byEmployee.get(row.employeeId) ?? {
        employeeId: row.employeeId,
        siteId: row.siteId,
        clockIns: 0,
        flagged: 0,
      };
      running.clockIns += 1;
      if (row.method === 'PIN_FALLBACK' || row.method === 'STAFF_PASSKEY') {
        running.flagged += 1;
      }
      byEmployee.set(row.employeeId, running);
    }
    return [...byEmployee.values()];
  }

  /**
   * How many times each supervisor confirmed somebody else at a kiosk since
   * `from` (rule R7).
   *
   * A co-sign is the strongest way around the camera, because the worker
   * need not be there at all — so the person doing the co-signing is counted
   * as carefully as the person being let in.
   */
  async coSignsPerSupervisor(
    companyId: string,
    from: Date,
  ): Promise<{ employeeId: string; coSigns: number }[]> {
    // Only the ones that let somebody in. A supervisor's face is recorded as
    // MATCHED the moment the kiosk recognises it, before anything is
    // decided, so counting attempts would count every refused co-sign too —
    // and a supervisor whose co-signs are all refused is the opposite of the
    // person this rule is looking for.
    //
    // A co-sign's punch carries the attempt's own id as its device event id,
    // which is what joins the two.
    const punches = await this.prisma.punchEvent.findMany({
      where: { companyId, method: 'PIN_FALLBACK', serverTime: { gte: from } },
      select: { deviceEventId: true },
    });
    if (punches.length === 0) {
      return [];
    }
    const rows = await this.prisma.clockInAttempt.groupBy({
      by: ['employeeId'],
      where: {
        companyId,
        purpose: 'CO_SIGN',
        employeeId: { not: null },
        id: { in: punches.map((punch) => punch.deviceEventId) },
      },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row.employeeId !== null)
      .map((row) => ({ employeeId: row.employeeId as string, coSigns: row._count._all }));
  }

  /**
   * Every two-person decision already on the record, and everybody who had
   * a hand in those workers' biometrics before it (rule R11).
   *
   * It reads the decisions and the hands separately and lets the rule put
   * them together, so the comparison itself can be tested without a
   * database.
   */
  async twoPersonDecisions(companyId: string): Promise<{
    decisions: {
      kind: 'duplicate review' | 'exemption';
      recordId: string;
      employeeIds: string[];
      subjectEmployeeId: string;
      decidedByUserId: string;
      decidedAt: Date;
    }[];
    hands: {
      employeeId: string;
      userId: string;
      did: 'enrolled' | 'wiped' | 'withdrew';
      at: Date;
    }[];
  }> {
    const [reviews, exemptions] = await Promise.all([
      this.prisma.biometricCredential.findMany({
        where: {
          companyId,
          kind: 'FACE',
          verdict: { not: null },
          resolvedByUserId: { not: null },
          resolvedAt: { not: null },
        },
        select: {
          id: true,
          employeeId: true,
          collisionEmployeeId: true,
          resolvedByUserId: true,
          resolvedAt: true,
        },
      }),
      this.prisma.biometricExemption.findMany({
        where: { companyId, reviewedByUserId: { not: null }, reviewedAt: { not: null } },
        select: { id: true, employeeId: true, reviewedByUserId: true, reviewedAt: true },
      }),
    ]);

    // Who decided and when are stored together or not at all — a database
    // CHECK on each table says so — and both queries above ask for both. The
    // narrowing below is how TypeScript is told that; it is not a place where
    // a half-decided row quietly turns into a decision dated 1970, which would
    // have hidden it from the rule rather than raised it.
    const decisions = [
      ...reviews
        .filter(
          (row): row is typeof row & { resolvedByUserId: string; resolvedAt: Date } =>
            row.resolvedByUserId !== null && row.resolvedAt !== null,
        )
        .map((row) => ({
          kind: 'duplicate review' as const,
          recordId: row.id,
          employeeIds: [row.employeeId, row.collisionEmployeeId].filter(
            (id): id is string => id !== null,
          ),
          subjectEmployeeId: row.employeeId,
          decidedByUserId: row.resolvedByUserId,
          decidedAt: row.resolvedAt,
        })),
      ...exemptions
        .filter(
          (row): row is typeof row & { reviewedByUserId: string; reviewedAt: Date } =>
            row.reviewedByUserId !== null && row.reviewedAt !== null,
        )
        .map((row) => ({
          kind: 'exemption' as const,
          recordId: row.id,
          employeeIds: [row.employeeId],
          subjectEmployeeId: row.employeeId,
          decidedByUserId: row.reviewedByUserId,
          decidedAt: row.reviewedAt,
        })),
    ];
    if (decisions.length === 0) {
      return { decisions: [], hands: [] };
    }

    const involved = [...new Set(decisions.flatMap((decision) => decision.employeeIds))];
    const [credentials, withdrawals] = await Promise.all([
      this.prisma.biometricCredential.findMany({
        where: { companyId, employeeId: { in: involved } },
        select: {
          employeeId: true,
          enrolledByUserId: true,
          enrolledAt: true,
          wipedByUserId: true,
          wipedAt: true,
        },
      }),
      this.prisma.biometricConsent.findMany({
        where: { companyId, employeeId: { in: involved }, status: 'WITHDRAWN' },
        select: { employeeId: true, recordedByUserId: true, recordedAt: true },
      }),
    ]);
    const hands: {
      employeeId: string;
      userId: string;
      did: 'enrolled' | 'wiped' | 'withdrew';
      at: Date;
    }[] = [];
    for (const credential of credentials) {
      if (credential.enrolledByUserId) {
        hands.push({
          employeeId: credential.employeeId,
          userId: credential.enrolledByUserId,
          did: 'enrolled',
          at: credential.enrolledAt,
        });
      }
      if (credential.wipedByUserId && credential.wipedAt) {
        hands.push({
          employeeId: credential.employeeId,
          userId: credential.wipedByUserId,
          did: 'wiped',
          at: credential.wipedAt,
        });
      }
    }
    for (const withdrawal of withdrawals) {
      hands.push({
        employeeId: withdrawal.employeeId,
        userId: withdrawal.recordedByUserId,
        did: 'withdrew',
        at: withdrawal.recordedAt,
      });
    }
    return { decisions, hands };
  }

  /**
   * What time each worker clocked in, day by day, since `from` (rule R8).
   *
   * One time per calendar day — the first clock-in of that day — because a
   * worker with two shifts would otherwise look erratic when they are not.
   * Ghana keeps GMT all year, so a moment's UTC minutes past midnight are
   * also Accra's.
   */
  async clockInTimesPerEmployee(
    companyId: string,
    from: Date,
  ): Promise<{ employeeId: string; siteId: string; minutesOfDay: number[] }[]> {
    const rows = await this.prisma.punchEvent.findMany({
      where: {
        companyId,
        employeeId: { not: null },
        direction: 'IN',
        pairable: true,
        // A device whose own clock the server already doubted cannot be used
        // to judge how regular somebody's arrivals are: the fault would be
        // the terminal's and the alert would be the worker's.
        clockSuspect: false,
        serverTime: { gte: from },
      },
      select: { employeeId: true, siteId: true, deviceTime: true },
      orderBy: { deviceTime: 'asc' },
    });
    const byEmployee = new Map<
      string,
      { employeeId: string; siteId: string; perDay: Map<string, number> }
    >();
    for (const row of rows) {
      if (row.employeeId === null) {
        continue;
      }
      const running = byEmployee.get(row.employeeId) ?? {
        employeeId: row.employeeId,
        siteId: row.siteId,
        perDay: new Map<string, number>(),
      };
      const day = toAccraDate(row.deviceTime);
      if (!running.perDay.has(day)) {
        running.perDay.set(day, accraMinuteOfDay(row.deviceTime));
      }
      byEmployee.set(row.employeeId, running);
    }
    return [...byEmployee.values()].map((row) => ({
      employeeId: row.employeeId,
      siteId: row.siteId,
      minutesOfDay: [...row.perDay.values()],
    }));
  }

  /**
   * How busy each device has been, day by day, and how far its own clock is
   * off (rule R9).
   *
   * Every punch carries the device's own time, so a terminal running fast
   * can make a late arrival look punctual every day with nobody touching a
   * record — which is why the drift is reported beside the volume.
   */
  async deviceActivity(
    companyId: string,
    from: Date,
    to: Date = new Date(),
  ): Promise<
    {
      deviceId: string;
      deviceName: string;
      siteId: string;
      dailyCounts: number[];
      clockDriftSeconds: number | null;
    }[]
  > {
    const devices = await this.prisma.device.findMany({
      where: { companyId },
      select: { id: true, name: true, siteId: true, lastClockDriftSeconds: true },
    });
    if (devices.length === 0) {
      return [];
    }
    const punches = await this.prisma.punchEvent.findMany({
      where: { companyId, serverTime: { gte: from } },
      select: { deviceId: true, serverTime: true },
    });
    const perDevice = new Map<string, Map<string, number>>();
    for (const punch of punches) {
      const days = perDevice.get(punch.deviceId) ?? new Map<string, number>();
      const day = toAccraDate(punch.serverTime);
      days.set(day, (days.get(day) ?? 0) + 1);
      perDevice.set(punch.deviceId, days);
    }
    // Every calendar day in the window, in order, with a **zero** for a day
    // the device said nothing. A silent day that was simply missing would
    // shuffle the array along, so "the last entry" would be the last day the
    // device spoke rather than today — and a spike from last week would keep
    // being judged as though it had just happened.
    const calendar = daysBetween(from, to);
    return devices.map((device) => {
      const days = perDevice.get(device.id) ?? new Map<string, number>();
      const dailyCounts = calendar.map((day) => days.get(day) ?? 0);
      return {
        deviceId: device.id,
        deviceName: device.name,
        siteId: device.siteId,
        dailyCounts,
        clockDriftSeconds: device.lastClockDriftSeconds,
      };
    });
  }

  /**
   * How many punches on each device matched nobody since `from` (rule R10),
   * and which numbers were tried — which is what tells a typo apart from
   * somebody working through numbers to see which ones answer.
   */
  async orphanPunchesPerDevice(
    companyId: string,
    from: Date,
  ): Promise<
    {
      deviceId: string;
      deviceName: string;
      siteId: string;
      punches: number;
      numbersTried: string[];
    }[]
  > {
    const rows = await this.prisma.punchEvent.findMany({
      where: { companyId, employeeId: null, serverTime: { gte: from } },
      select: {
        deviceId: true,
        siteId: true,
        deviceUserRef: true,
        device: { select: { name: true } },
      },
    });
    const byDevice = new Map<
      string,
      {
        deviceId: string;
        deviceName: string;
        siteId: string;
        punches: number;
        numbersTried: Set<string>;
      }
    >();
    for (const row of rows) {
      const running = byDevice.get(row.deviceId) ?? {
        deviceId: row.deviceId,
        deviceName: row.device.name,
        siteId: row.siteId,
        punches: 0,
        numbersTried: new Set<string>(),
      };
      running.punches += 1;
      running.numbersTried.add(row.deviceUserRef);
      byDevice.set(row.deviceId, running);
    }
    return [...byDevice.values()].map((row) => ({
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      siteId: row.siteId,
      punches: row.punches,
      numbersTried: [...row.numbersTried].sort(),
    }));
  }
}
