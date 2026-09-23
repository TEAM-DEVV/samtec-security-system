import { ConflictException, Injectable } from '@nestjs/common';
import type {
  TerminalEnrollmentResult,
  TerminalEnrollmentsResponse,
  TerminalRosterResponse,
} from '@samtec/contracts';
import { fromIsoDate, toAccraDate } from '../../common/dates.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type { TerminalEnrollmentsBody } from './attendance.schemas.js';
import type { SignedDevice } from './device-signature.guard.js';
import { staffNumberForDeviceUser } from './punch-rules.js';

/**
 * What a ZKTeco terminal asks for and reports, through the gateway
 * (docs/plan/13-biometrics-design.md section 5).
 *
 * Two things only. **The roster** says who should be on the terminal, so the
 * gateway can add and remove users to match; it changes nothing here, which
 * is why the server needs no command table and the gateway can simply ask
 * again every five minutes.
 *
 * **An enrollment report** says that a user enrolled a finger on a terminal at
 * a moment. The fingerprint itself is thrown away by the gateway and never
 * reaches this server, so there is nothing here to compare and nothing to
 * steal: what is kept is the fact, not the finger.
 *
 * The rule that matters is that **a terminal never enrolls anybody by
 * itself**. A finger only counts when an ADMIN opened a window for that
 * worker on that terminal and it is still open. Everything else is written
 * down and raised as an exception, so a terminal quietly adding people is
 * visible on the dashboard instead of silent.
 */
@Injectable()
export class GatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  /**
   * Everyone this terminal should know about: posted to its site, at work or
   * waiting to be enrolled, and not blocked as a duplicate.
   *
   * A blocked record is left out on purpose — that is how the duplicate
   * decision reaches the terminals and takes the losing record's fingers off
   * them (docs/plan/13 §2).
   */
  async roster(device: SignedDevice): Promise<TerminalRosterResponse> {
    const posted = await this.employees.atSite(device.companyId, device.siteId);
    const blocked = await this.blockedHere(
      device.companyId,
      posted.map((person) => person.id),
    );
    return {
      users: posted
        .filter((person) => !blocked.has(person.id))
        .map((person) => ({
          // A terminal calls people by their staff number, which is also what
          // a punch carries back (`staffNumberForDeviceUser`).
          deviceUserRef: person.staffNumber,
          staffNumber: person.staffNumber,
          displayName: shortName(person),
        })),
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * A terminal reports fingers it enrolled. Each one is written down whatever
   * happens, and only the ones an ADMIN asked for become a credential.
   */
  async recordEnrollments(
    device: SignedDevice,
    body: TerminalEnrollmentsBody,
  ): Promise<TerminalEnrollmentsResponse> {
    const results: TerminalEnrollmentResult[] = [];
    for (const report of body.enrollments) {
      results.push(await this.recordOne(device, report));
    }
    return { results };
  }

  private async recordOne(
    device: SignedDevice,
    report: TerminalEnrollmentsBody['enrollments'][number],
  ): Promise<TerminalEnrollmentResult> {
    const enrolledAt = new Date(report.enrolledAt);
    const answer = (status: TerminalEnrollmentResult['status']): TerminalEnrollmentResult => ({
      deviceUserRef: report.deviceUserRef,
      enrolledAt: enrolledAt.toISOString(),
      status,
    });

    const staffNumber = staffNumberForDeviceUser(report.deviceUserRef);
    const worker = staffNumber
      ? await this.employees.atTheKiosk(device.companyId, { staffNumber })
      : null;

    try {
      const accepted = await this.prisma.$transaction(async (tx) => {
        // The window is checked against the **server's** clock, not the time
        // the terminal reports. A terminal with a wound-back clock must not
        // be able to claim it enrolled somebody inside a window that has
        // since closed.
        const open = worker ? await this.openWindow(tx, device, worker.id, new Date()) : null;
        if (!open) {
          await tx.terminalEnrollmentReport.create({
            data: {
              companyId: device.companyId,
              deviceId: device.id,
              deviceUserRef: report.deviceUserRef,
              // A number that matches nobody is written down as it came and
              // nothing else.
              employeeId: worker?.id ?? null,
              fingerIndex: report.fingerIndex ?? null,
              enrolledAt,
              accepted: false,
            },
            select: { id: true },
          });
          await this.raiseUnexpected(
            tx,
            device,
            report.deviceUserRef,
            worker?.id ?? null,
            enrolledAt,
          );
          return false;
        }

        const consent = await tx.biometricConsent.findFirst({
          where: { companyId: device.companyId, employeeId: open.employeeId },
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true },
        });
        const credential = await tx.biometricCredential.create({
          data: {
            companyId: device.companyId,
            employeeId: open.employeeId,
            kind: 'TERMINAL_FINGER',
            deviceId: device.id,
            // No template and no model: this server never sees a terminal's
            // fingerprint, so it has nothing to seal and nothing to compare.
            templateSealed: null,
            keyVersion: null,
            faceModel: null,
            consentId: consent?.status === 'GIVEN' ? consent.id : null,
            // The ADMIN who opened the window is who enrolled this finger.
            enrolledByUserId: open.openedByUserId,
            dedupe: 'NOT_CHECKED',
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await tx.terminalEnrollmentReport.create({
          data: {
            companyId: device.companyId,
            deviceId: device.id,
            deviceUserRef: report.deviceUserRef,
            employeeId: open.employeeId,
            fingerIndex: report.fingerIndex ?? null,
            enrolledAt,
            accepted: true,
            credentialId: credential.id,
            windowId: open.id,
          },
          select: { id: true },
        });
        // The window is spent: one window, one finger.
        await tx.fingerEnrollmentWindow.update({
          where: { id: open.id },
          data: { expiresAt: new Date() },
        });
        await this.audit.record(
          {
            companyId: device.companyId,
            actorUserId: open.openedByUserId,
            action: 'biometric.terminal_finger_enrolled',
            entityType: 'employee',
            entityId: open.employeeId,
            detail: { deviceId: device.id, credentialId: credential.id, windowId: open.id },
          },
          tx,
        );
        return true;
      });
      return answer(accepted ? 'ACCEPTED' : 'REFUSED');
    } catch (error) {
      if (isUniqueViolation(error, 'device_user_ref')) {
        // The same terminal, user and moment: the gateway is resending a
        // batch it did not hear an answer for. Nothing new happened.
        return answer('DUPLICATE');
      }
      throw error;
    }
  }

  /** The window an ADMIN opened for this worker on this terminal, if one is open now. */
  private async openWindow(
    tx: Prisma.TransactionClient,
    device: SignedDevice,
    employeeId: string,
    now: Date,
  ) {
    return tx.fingerEnrollmentWindow.findFirst({
      where: {
        companyId: device.companyId,
        deviceId: device.id,
        employeeId,
        opensAt: { lte: now },
        expiresAt: { gt: now },
      },
      orderBy: { opensAt: 'desc' },
      select: { id: true, employeeId: true, openedByUserId: true },
    });
  }

  /**
   * A terminal reported a finger nobody asked for. Grouped per device, number
   * and day, so one misbehaving terminal cannot flood the queue.
   */
  private async raiseUnexpected(
    tx: Prisma.TransactionClient,
    device: SignedDevice,
    deviceUserRef: string,
    employeeId: string | null,
    enrolledAt: Date,
  ): Promise<void> {
    const workDate = toAccraDate(enrolledAt);
    await tx.attendanceException.createMany({
      data: [
        {
          companyId: device.companyId,
          siteId: device.siteId,
          type: 'UNEXPECTED_DEVICE_ENROLLMENT',
          employeeId,
          occurredAt: enrolledAt,
          workDate: fromIsoDate(workDate),
          dedupeKey: `UNEXPECTED_DEVICE_ENROLLMENT:${device.id}:${deviceUserRef}:${workDate}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Which of these workers have a biometric record blocked as a duplicate. */
  private async blockedHere(companyId: string, employeeIds: string[]): Promise<Set<string>> {
    if (employeeIds.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.biometricCredential.findMany({
      where: { companyId, employeeId: { in: employeeIds }, status: 'BLOCKED' },
      select: { employeeId: true },
    });
    return new Set(rows.map((row) => row.employeeId));
  }
}

/**
 * A first name and the surname's initial, the same as a kiosk screen: a
 * terminal at a gate is read by whoever walks past it.
 */
function shortName(person: { firstName: string; lastName: string }): string {
  const initial = person.lastName.trim().charAt(0).toUpperCase();
  return initial ? `${person.firstName} ${initial}.` : person.firstName;
}
