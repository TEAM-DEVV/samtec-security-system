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
