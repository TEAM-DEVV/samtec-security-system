import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

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
