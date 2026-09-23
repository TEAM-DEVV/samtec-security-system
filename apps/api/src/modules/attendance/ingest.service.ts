import { Injectable } from '@nestjs/common';
import type { HeartbeatResponse, IngestPunchesResponse, PunchResult } from '@samtec/contracts';
import { fromIsoDate, toAccraDate } from '../../common/dates.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService, type StaffLookup } from '../workforce/employees.service.js';
import type { HeartbeatBody, IngestPunchesBody } from './attendance.schemas.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS,
  AttendanceBusyException,
  isLockTimeout,
  lockCompanyAttendance,
} from './attendance-lock.js';
import { BiometricRetentionService } from './biometric-retention.service.js';
import type { SignedDevice } from './device-signature.guard.js';
import { PairingService } from './pairing.service.js';
import {
  judgePunchTime,
  mayClockIn,
  punchPayloadHash,
  staffNumberForDeviceUser,
} from './punch-rules.js';

/** A new punch that was just stored, with what the exception rules need. */
interface StoredPunch {
  punchId: string;
  companyId: string;
  deviceId: string;
  siteId: string;
  deviceUserRef: string;
  employeeId: string | null;
  deviceTime: Date;
}

/**
 * Receives punches from devices. Transport-independent: the signed HTTP route
 * calls it today, and Phase 3's gateway and face kiosk will call the same
 * method. Each batch is ONE transaction under the company's attendance lock:
 * store, match, raise exceptions, re-pair the people who punched, commit. If anything fails nothing is kept,
 * and the device resends — which is always safe (docs/plan/12 §2 and §6).
 */
@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly pairing: PairingService,
    private readonly retention: BiometricRetentionService,
  ) {}

  async ingestPunches(
    device: SignedDevice,
    body: IngestPunchesBody,
  ): Promise<IngestPunchesResponse> {
    const serverTime = new Date();
    const clockDriftSeconds = driftSeconds(body.deviceClockAt, serverTime);

    // Workforce reads come before the transaction (module rule: ask the
    // workforce service; and never make a locked transaction wait on it).
    const staffNumbers = body.punches
      .map((punch) => staffNumberForDeviceUser(punch.deviceUserRef))
      .filter((staffNumber): staffNumber is string => staffNumber !== undefined);
    const people = await this.employees.findByStaffNumbers(device.companyId, staffNumbers);

    const rows = body.punches.map((punch) => {
      const deviceTime = new Date(punch.deviceTime);
      const staffNumber = staffNumberForDeviceUser(punch.deviceUserRef);
      const person = staffNumber ? people.get(staffNumber) : undefined;
      return {
        companyId: device.companyId,
        deviceId: device.id,
        siteId: device.siteId,
        deviceEventId: punch.deviceEventId,
        deviceUserRef: punch.deviceUserRef,
        employeeId: person?.id ?? null,
        deviceTime,
        serverTime,
        clockDriftSeconds,
        ...judgePunchTime(deviceTime, serverTime, clockDriftSeconds),
        direction: punch.direction,
        method: punch.method,
        payloadHash: punchPayloadHash({ ...punch, deviceTime }),
      };
    });

    try {
      const results = await this.prisma.$transaction(async (tx) => {
        await lockCompanyAttendance(tx, device.companyId);

        // Only new punches come back; resends are skipped by the unique rule.
        const stored = await tx.punchEvent.createManyAndReturn({
          data: rows,
          skipDuplicates: true,
          select: { id: true, deviceEventId: true },
        });
        const storedIds = new Map(stored.map((row) => [row.deviceEventId, row.id]));
        const resent = rows
          .filter((row) => !storedIds.has(row.deviceEventId))
          .map((row) => row.deviceEventId);
        const earlier =
          resent.length === 0
            ? []
            : await tx.punchEvent.findMany({
                where: { deviceId: device.id, deviceEventId: { in: resent } },
                select: { id: true, deviceEventId: true, payloadHash: true },
              });
        const earlierById = new Map(earlier.map((row) => [row.deviceEventId, row]));

        const results: PunchResult[] = [];
        for (const row of rows) {
          const newId = storedIds.get(row.deviceEventId);
          if (newId) {
            results.push({ deviceEventId: row.deviceEventId, status: 'ACCEPTED', punchId: newId });
            continue;
          }
          const previous = earlierById.get(row.deviceEventId);
          if (!previous) {
            throw new Error('A skipped punch has no earlier row');
          }
          const same = previous.payloadHash === row.payloadHash;
          results.push({
            deviceEventId: row.deviceEventId,
            status: same ? 'DUPLICATE' : 'CONFLICT',
            punchId: previous.id,
          });
          if (!same) {
            // The same event ID with different content: kept out, and recorded.
            await this.audit.record(
              {
                companyId: device.companyId,
                actorUserId: null,
                action: 'attendance.punch_conflict',
                entityType: 'punch',
                entityId: previous.id,
                detail: { deviceId: device.id },
              },
              tx,
            );
          }
        }

        const accepted: StoredPunch[] = rows.flatMap((row) => {
          const punchId = storedIds.get(row.deviceEventId);
          return punchId ? [{ ...row, punchId }] : [];
        });
        await this.raiseWhoExceptions(tx, accepted, people);
        await this.pairing.repair(
          tx,
          device.companyId,
          rows.flatMap((row) =>
            storedIds.has(row.deviceEventId) && row.pairable && row.employeeId
              ? [row.employeeId]
              : [],
          ),
          serverTime,
        );

        if (clockDriftSeconds !== null) {
          await tx.device.update({
            where: { id: device.id },
            data: { lastClockDriftSeconds: clockDriftSeconds },
          });
        }
        return results;
      }, ATTENDANCE_TRANSACTION_OPTIONS);

      return {
        serverTime: serverTime.toISOString(),
        accepted: results.filter((result) => result.status === 'ACCEPTED').length,
        duplicates: results.filter((result) => result.status === 'DUPLICATE').length,
        conflicts: results.filter((result) => result.status === 'CONFLICT').length,
        results,
      };
    } catch (error) {
      throw isLockTimeout(error) ? new AttendanceBusyException() : error;
    }
  }

  async heartbeat(device: SignedDevice, body: HeartbeatBody): Promise<HeartbeatResponse> {
    const serverTime = new Date();
    const clockDriftSeconds = driftSeconds(body.deviceClockAt, serverTime);
    if (clockDriftSeconds !== null) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastClockDriftSeconds: clockDriftSeconds },
      });
    }
    // The only way a forgotten clock-out is noticed when nothing else happens.
    await this.pairing.repairOverdueClockIns(device.companyId, serverTime);
    // And the only thing that deletes biometrics on time, for the same
    // reason: there is no scheduled job (docs/plan/13 §2).
    await this.retention.sweep(device.companyId, serverTime);
    return { serverTime: serverTime.toISOString() };
  }

  /**
   * "Who is this?" exceptions for newly stored punches: a user number that
   * matches nobody, or someone who may not clock in. Grouped per device +
   * number + day and per person + day, so one misconfigured terminal cannot
   * flood the queue; the unique dedupe key makes raising one twice harmless.
   */
  private async raiseWhoExceptions(
    tx: Prisma.TransactionClient,
    accepted: StoredPunch[],
    people: Map<string, StaffLookup>,
  ): Promise<void> {
    const byEmployeeId = new Map([...people.values()].map((person) => [person.id, person]));
    const data: Prisma.AttendanceExceptionCreateManyInput[] = [];
    for (const row of accepted) {
      const workDate = toAccraDate(row.deviceTime);
      const base = {
        companyId: row.companyId,
        siteId: row.siteId,
        punchId: row.punchId,
        occurredAt: row.deviceTime,
        workDate: fromIsoDate(workDate),
      };
      if (row.employeeId === null) {
        data.push({
          ...base,
          type: 'UNKNOWN_EMPLOYEE',
          dedupeKey: `UNKNOWN_EMPLOYEE:${row.deviceId}:${row.deviceUserRef}:${workDate}`,
        });
        continue;
      }
      const person = byEmployeeId.get(row.employeeId);
      if (person && !mayClockIn(person, workDate)) {
        data.push({
          ...base,
          type: 'INACTIVE_EMPLOYEE',
          employeeId: row.employeeId,
          dedupeKey: `INACTIVE_EMPLOYEE:${row.employeeId}:${workDate}`,
        });
      }
    }
    if (data.length > 0) {
      await tx.attendanceException.createMany({ data, skipDuplicates: true });
    }
  }
}

/** The device clock minus the server clock, in whole seconds (positive = fast). */
function driftSeconds(deviceClockAt: string | undefined, serverTime: Date): number | null {
  return deviceClockAt === undefined
    ? null
    : Math.round((Date.parse(deviceClockAt) - serverTime.getTime()) / 1000);
}
